import { workerData, parentPort } from 'worker_threads';
import { WasmLoader } from '../wasm/instance';
import { createBridgeImports, resetPerRequestBridgeState } from '../bridge';
import {
  installLogInterceptor as installDevCaptureLogInterceptor,
  recordRequest as devCaptureRecordRequest,
  setCurrentWasm as devCaptureSetCurrentWasm,
  isEnabled as devCaptureEnabled,
} from '../bridge/dev-snapshot';
import { BrokerSessionStore } from '../session/broker-store';
import { createDatabaseDriver } from '../database';
import { setSandboxRoot } from '../bridge/file';
import { SyncHttpClient } from '../bridge/http-client';
import { setRequestContext, getResponse } from '../wasm/state';
import { readLengthPrefixedString, preGrowMemory } from '../wasm/memory';
import { computeRetainedGrowth, shouldRotate } from '../wasm/pool';
import { RouteRegistry } from '../router';
import { setRouteRegistry } from '../bridge/http-server';
import { WasmState, DatabaseDriver } from '../types';
import {
  WorkerInit,
  WorkerInbound,
  WorkerRequestMsg,
  WorkerResponseMsg,
  WorkerErrorMsg,
  WorkerReadyMsg,
  WorkerFatalMsg,
} from './worker-types';

if (!parentPort) {
  throw new Error('request-worker must be run as a worker thread');
}

const MAX_REQUEST_COUNT = 1000;
const MAX_HEAP_GROWTH_BYTES = 50 * 1024 * 1024;

const {
  wasmPath,
  config,
  databaseUrl,
  sandboxRoot,
  sessionControlBuffer,
  sessionDataBuffer,
  pgMaxConnections,
} = workerData as WorkerInit;

setSandboxRoot(sandboxRoot);

// Dev-mode capture log interceptor. Idempotent + CLEAN_DEV-gated at the
// callsite, so this is safe to always call; in production it returns
// immediately and console.* stays unwrapped. See dev-snapshot.ts.
installDevCaptureLogInterceptor();

let wasmState: WasmState | null = null;
let database: DatabaseDriver | undefined;
let httpWorkerClient: SyncHttpClient | null = null;
let requestCount = 0;
let initialHeapPtr = 0;
let initialMemoryBytes = 0;

/**
 * Reconstruct the wire-format path (`/foo?a=1&b=2`) from the parsed context.
 * Query keys/values are URL-encoded — the parser strips encoding on the way
 * in, so we re-encode on the way out. Empty query object yields just the path.
 * Used exclusively by the dev-mode request ring buffer.
 */
function buildPathAndQuery(pathOnly: string, query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return pathOnly;
  const pairs = keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
    .join('&');
  return `${pathOnly}?${pairs}`;
}

function readHeapPtr(): number {
  if (!wasmState) return 0;
  const g = (wasmState.instance.exports as Record<string, unknown>).__heap_ptr;
  if (g && typeof (g as WebAssembly.Global).value === 'number') {
    return (g as WebAssembly.Global).value as number;
  }
  return wasmState.memoryStats.initialHeapPtr;
}

function readMemoryBytes(): number {
  if (!wasmState) return 0;
  return wasmState.exports.memory.buffer.byteLength;
}

function effectiveGrowthBytes(): number {
  return computeRetainedGrowth(readHeapPtr(), readMemoryBytes(), initialHeapPtr, initialMemoryBytes);
}

function resetRequestState(): void {
  if (!wasmState) return;
  wasmState.httpClient = {
    timeout: 30000,
    userAgent: null,
    maxRedirects: 5,
    cookiesEnabled: false,
    cookieJar: new Map(),
    lastResponse: null,
  };
}

async function initialize(): Promise<void> {
  // Session store that delegates to main thread via SharedArrayBuffer IPC.
  const sessionStore = new BrokerSessionStore(sessionControlBuffer, sessionDataBuffer);

  const routeRegistry = new RouteRegistry();
  setRouteRegistry(routeRegistry);

  if (databaseUrl) {
    database = await createDatabaseDriver(databaseUrl, pgMaxConnections);
  }

  httpWorkerClient = new SyncHttpClient();
  const loader = new WasmLoader(wasmPath);
  // Pre-load so `getBytes()` is populated before the dev-capture bridge can
  // be invoked from a handler. In production (CLEAN_DEV unset) `setCurrentWasm`
  // still runs but the bytes are only surfaced when snapshotJson() gates open.
  await loader.load();
  const wasmBytesForCapture = loader.getBytes();
  if (wasmBytesForCapture) {
    devCaptureSetCurrentWasm(wasmBytesForCapture, wasmPath);
  }

  let state: WasmState | null = null;
  const imports = createBridgeImports(() => {
    if (!state) throw new Error('[request-worker] WASM state not initialized');
    return state;
  });

  state = await loader.createInstance(
    imports,
    config,
    sessionStore,
    routeRegistry.getRoutes(),
    database,
    httpWorkerClient
  );
  wasmState = state;

  const { exports } = state;
  preGrowMemory(exports, config.preGrowMemoryBytes);

  if (typeof exports.start === 'function') {
    (exports.start as () => void)();
  } else if (typeof exports._start === 'function') {
    (exports._start as () => void)();
  }

  state.routeRegistry = routeRegistry.getRoutes();
  initialHeapPtr = readHeapPtr();
  initialMemoryBytes = readMemoryBytes();

  parentPort!.postMessage({ type: 'ready' } satisfies WorkerReadyMsg);
}

parentPort.on('message', (msg: WorkerInbound) => {
  if (msg.type !== 'request') return;

  const { id, context, handlerName } = msg as WorkerRequestMsg;

  if (!wasmState) {
    parentPort!.postMessage({
      type: 'response', id, ok: false,
      error: 'Worker not initialized', needsRestart: false,
    } satisfies WorkerErrorMsg);
    return;
  }

  // Dev-mode request ring buffer timing. Read once at the top so the
  // pre-scope path length is included; the recording call below is gated on
  // devCaptureEnabled() so this is a no-op in production.
  const devCaptureStartNs = devCaptureEnabled() ? process.hrtime.bigint() : 0n;

  // Per-request scope wraps the WASM handler invocation so the bump allocator
  // is rewound after each request. Compiler 0.30.330+ exports `scope_push`
  // (returns saved `__heap_ptr`) and `scope_pop` (restores it). Without this,
  // every `string.concat` / writeLengthPrefixedString / __malloc call from the
  // handler is permanently retained — none of those go through `mem_alloc` /
  // refcount tracking, so per-allocation reclaim cannot reach them. See
  // CNS-MEM-SCOPE-POP-IGNORES-NEW-COMPILER-PRIMITIVE.
  const scopePushFn = (wasmState.exports as unknown as Record<string, unknown>).scope_push as
    | (() => number)
    | undefined;
  const scopePopFn = (wasmState.exports as unknown as Record<string, unknown>).scope_pop as
    | ((snapshot: number) => void)
    | undefined;
  const hasScopes = typeof scopePushFn === 'function' && typeof scopePopFn === 'function';
  let requestScopeSnapshot = 0;

  try {
    if (hasScopes) {
      requestScopeSnapshot = scopePushFn!();
    }

    setRequestContext(wasmState, context);
    resetRequestState();

    const handler = wasmState.exports[handlerName];
    if (typeof handler !== 'function') {
      throw new Error(`Handler function not found: ${handlerName}`);
    }

    const resultPtr = (handler as () => number)();

    if (resultPtr > 0) {
      const responseBody = readLengthPrefixedString(wasmState.exports.memory, resultPtr);
      if (responseBody) wasmState.response.body = responseBody;
    }

    const body = wasmState.response.body;
    if (
      wasmState.response.headers['Content-Type'] === 'application/json' &&
      body &&
      (body.trimStart().startsWith('<!DOCTYPE') ||
        body.trimStart().startsWith('<html') ||
        body.trimStart().startsWith('<HTML'))
    ) {
      wasmState.response.headers['Content-Type'] = 'text/html; charset=utf-8';
    }

    const response = getResponse(wasmState);

    // Dev-mode capture: record the completed request into the worker-local
    // ring buffer. Gated on CLEAN_DEV=1 inside `recordRequest` so this is
    // effectively free in production. Redaction of Cookie/Authorization
    // happens at write time inside the ring buffer.
    if (devCaptureEnabled()) {
      const durationMs = Number(process.hrtime.bigint() - devCaptureStartNs) / 1e6;
      const bodyBytes = context.bodyBytes ?? Buffer.from(context.body ?? '', 'utf8');
      const contentType = context.headers['content-type'] ?? context.headers['Content-Type'];
      devCaptureRecordRequest({
        method: context.method,
        pathAndQuery: buildPathAndQuery(context.path, context.query),
        status: response.status,
        durationMs: Math.round(durationMs),
        headers: Object.entries(context.headers),
        bodyBytes,
        contentType,
      });
    }

    // Response body, headers, and cookies are already materialized as JS
    // strings/objects above; rewinding the WASM heap is safe from here on.
    if (hasScopes) {
      try { scopePopFn!(requestScopeSnapshot); } catch { /* trap; instance restart will handle */ }
    }
    // Release JS-side bridge accumulators (listStore, arrayStore, refCounts).
    // scope_pop only rewinds WASM linear memory; without this every handler
    // that touches a list/array (directly, or transitively via plugin code)
    // leaks its JS handles for the worker's lifetime — the residual RSS
    // growth reported in NSR-HTTP-SCOPE-WRAP-INCOMPLETE.
    resetPerRequestBridgeState();

    requestCount++;
    const heapGrown = effectiveGrowthBytes();
    const needsRestart = shouldRotate(requestCount, heapGrown, MAX_REQUEST_COUNT, MAX_HEAP_GROWTH_BYTES);

    parentPort!.postMessage({
      type: 'response',
      id,
      ok: true,
      status: response.status,
      headers: { ...response.headers },
      body: response.body,
      cookies: (response.cookies ?? []).map((c) => ({
        name: c.name,
        value: c.value,
        options: c.options as Record<string, unknown> | undefined,
      })),
      needsRestart,
    } satisfies WorkerResponseMsg);

  } catch (err) {
    // Errors must count toward rotation thresholds the same as successes.
    // A WASM heap that was partially advanced before the throw stays advanced
    // (WASM has no GC), so a high-error-rate endpoint that returns early via
    // throw would otherwise grow the heap indefinitely without ever tripping
    // MAX_REQUEST_COUNT or MAX_HEAP_GROWTH_BYTES — the root cause of
    // NODESERVER_MEM_LEAK on workloads where errors are common.
    //
    // Rewind the per-request scope on the error path too — without this, a
    // handler that traps mid-allocation would leak everything it allocated
    // before the trap (string concats, response prep, etc.). scope_pop only
    // restores the global; it doesn't depend on the WASM stack being intact.
    if (hasScopes) {
      try { scopePopFn!(requestScopeSnapshot); } catch { /* trap; instance restart will handle */ }
    }
    // Same JS-side bridge cleanup as the success path — see comment above.
    // Critical on the error path too: a partially-completed handler may have
    // populated listStore/arrayStore with handles to lists that the throw
    // prevented from being released.
    try { resetPerRequestBridgeState(); } catch { /* defensive — never block error reporting */ }
    // Dev-mode capture: record the failed request. Errors are reported with
    // HTTP 500 (or 503 upstream); we record 500 here since node-server's
    // status mapping happens in server.ts after the worker replies. The
    // status is close enough for the retest-sandbox flow — the reproducer's
    // interest is that a request *happened*, not its final HTTP code.
    if (devCaptureEnabled()) {
      try {
        const durationMs = Number(process.hrtime.bigint() - devCaptureStartNs) / 1e6;
        const bodyBytes = context.bodyBytes ?? Buffer.from(context.body ?? '', 'utf8');
        const contentType = context.headers['content-type'] ?? context.headers['Content-Type'];
        devCaptureRecordRequest({
          method: context.method,
          pathAndQuery: buildPathAndQuery(context.path, context.query),
          status: 500,
          durationMs: Math.round(durationMs),
          headers: Object.entries(context.headers),
          bodyBytes,
          contentType,
        });
      } catch { /* never block error reporting */ }
    }
    requestCount++;
    let heapGrown = 0;
    try { heapGrown = effectiveGrowthBytes(); } catch { /* heap unreadable post-trap */ }
    const needsRestart = shouldRotate(requestCount, heapGrown, MAX_REQUEST_COUNT, MAX_HEAP_GROWTH_BYTES);
    parentPort!.postMessage({
      type: 'response',
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      needsRestart,
    } satisfies WorkerErrorMsg);
  }
});

initialize().catch((err) => {
  console.error('[request-worker] Fatal initialization error:', err);
  parentPort!.postMessage({
    type: 'fatal',
    message: err instanceof Error ? err.message : String(err),
  } satisfies WorkerFatalMsg);
  process.exit(1);
});
