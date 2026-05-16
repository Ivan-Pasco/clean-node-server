import { workerData, parentPort } from 'worker_threads';
import { WasmLoader } from '../wasm/instance';
import { createBridgeImports } from '../bridge';
import { BrokerSessionStore } from '../session/broker-store';
import { createDatabaseDriver } from '../database';
import { setSandboxRoot } from '../bridge/file';
import { SyncHttpClient } from '../bridge/http-client';
import { setRequestContext, getResponse } from '../wasm/state';
import { readLengthPrefixedString } from '../wasm/memory';
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

let wasmState: WasmState | null = null;
let database: DatabaseDriver | undefined;
let httpWorkerClient: SyncHttpClient | null = null;
let requestCount = 0;
let initialHeapPtr = 0;

function readHeapPtr(): number {
  if (!wasmState) return 0;
  const g = (wasmState.instance.exports as Record<string, unknown>).__heap_ptr;
  if (g && typeof (g as WebAssembly.Global).value === 'number') {
    return (g as WebAssembly.Global).value as number;
  }
  return wasmState.memoryStats.initialHeapPtr;
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
  wasmState.injectedCss = undefined;
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
  if (typeof exports.start === 'function') {
    (exports.start as () => void)();
  } else if (typeof exports._start === 'function') {
    (exports._start as () => void)();
  }

  state.routeRegistry = routeRegistry.getRoutes();
  initialHeapPtr = readHeapPtr();

  parentPort!.postMessage({ type: 'ready' } satisfies WorkerReadyMsg);
}

parentPort.on('message', (msg: WorkerInbound) => {
  if (msg.type !== 'request') return;

  const { id, context, handlerIndex } = msg as WorkerRequestMsg;

  if (!wasmState) {
    parentPort!.postMessage({
      type: 'response', id, ok: false,
      error: 'Worker not initialized', needsRestart: false,
    } satisfies WorkerErrorMsg);
    return;
  }

  try {
    setRequestContext(wasmState, context);
    resetRequestState();

    const handlerName = `__route_handler_${handlerIndex}`;
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

    if (wasmState.injectedCss?.length && wasmState.response.headers['Content-Type']?.includes('text/html')) {
      const cssBlock = `<style>${wasmState.injectedCss.join('\n')}</style>`;
      wasmState.response.body = wasmState.response.body.replace('</head>', `${cssBlock}\n</head>`);
    }

    const response = getResponse(wasmState);

    requestCount++;
    const heapGrown = readHeapPtr() - initialHeapPtr;
    const needsRestart = requestCount >= MAX_REQUEST_COUNT || heapGrown > MAX_HEAP_GROWTH_BYTES;

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
    parentPort!.postMessage({
      type: 'response',
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      needsRestart: false,
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
