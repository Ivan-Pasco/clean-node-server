import { workerData, parentPort } from 'worker_threads';
import { WasmLoader } from '../wasm/instance';
import { createBridgeImports } from '../bridge';
import { createDatabaseDriver } from '../database';
import { setSandboxRoot } from '../bridge/file';
import { SyncHttpClient } from '../bridge/http-client';
import { setRequestContext } from '../wasm/state';
import { preGrowMemory, withWasmScope } from '../wasm/memory';
import { RouteRegistry } from '../router';
import { setRouteRegistry } from '../bridge/http-server';
import { WasmState, DatabaseDriver, SessionStore, SessionData } from '../types';
import {
  SseWorkerInit,
  SseWorkerInbound,
  SseWorkerRequestMsg,
  WorkerReadyMsg,
  WorkerFatalMsg,
} from './worker-types';

if (!parentPort) {
  throw new Error('sse-worker must be run as a worker thread');
}

const {
  wasmPath,
  config,
  databaseUrl,
  sandboxRoot,
  sseControlBuffer,
} = workerData as SseWorkerInit;

setSandboxRoot(sandboxRoot);

let wasmState: WasmState | null = null;
let database: DatabaseDriver | undefined;
let httpWorkerClient: SyncHttpClient | null = null;

/**
 * Minimal no-op session store for SSE handlers.
 * SSE connections are server-push streams; authentication is expected to have
 * been validated on the initial GET request by a regular route handler.
 */
const noopSessionStore: SessionStore = {
  create(_data: Omit<SessionData, 'createdAt' | 'expiresAt'>): string { return ''; },
  get(_sessionId: string): SessionData | undefined { return undefined; },
  destroy(_sessionId: string): boolean { return false; },
  cleanup(): void {},
};

async function initialize(): Promise<void> {
  const routeRegistry = new RouteRegistry();
  setRouteRegistry(routeRegistry);

  if (databaseUrl) {
    database = await createDatabaseDriver(databaseUrl);
  }

  httpWorkerClient = new SyncHttpClient();
  const loader = new WasmLoader(wasmPath);

  let state: WasmState | null = null;
  const imports = createBridgeImports(() => {
    if (!state) throw new Error('[sse-worker] WASM state not initialized');
    return state;
  });

  state = await loader.createInstance(
    imports,
    config,
    noopSessionStore,
    routeRegistry.getRoutes(),
    database,
    httpWorkerClient
  );
  wasmState = state;

  // Attach SSE context so _sse_* bridge functions are active.
  state.sseContext = { controlBuffer: sseControlBuffer };

  const { exports } = state;
  preGrowMemory(exports, config.preGrowMemoryBytes);

  if (typeof exports.start === 'function') {
    (exports.start as () => void)();
  } else if (typeof exports._start === 'function') {
    (exports._start as () => void)();
  }

  parentPort!.postMessage({ type: 'ready' } satisfies WorkerReadyMsg);
}

parentPort.on('message', (msg: SseWorkerInbound) => {
  if (msg.type !== 'sse_request') return;

  const { context, handlerName } = msg as SseWorkerRequestMsg;

  if (!wasmState) {
    parentPort!.postMessage({
      type: 'fatal',
      message: 'SSE worker not initialized',
    } satisfies WorkerFatalMsg);
    return;
  }

  try {
    setRequestContext(wasmState, context);

    const handler = wasmState.exports[handlerName];
    if (typeof handler !== 'function') {
      throw new Error(`SSE handler not found in WASM exports: ${handlerName}`);
    }

    // Per-connection scope rewinds every byte the SSE handler allocated
    // (sse_emit payloads, string concats, intermediate buffers) once it
    // returns. Without this the worker's bump pointer grows by the full sum
    // of all emitted frames and never recovers, even after the worker is
    // terminated and re-spawned for the next connection it leaked memory
    // during its lifetime. See NSR-NO-PER-REQUEST-MEMORY-RELEASE.
    withWasmScope(wasmState.exports, () => (handler as () => void)());

    // Handler returned normally — signal the main thread to close the stream.
    parentPort!.postMessage({ type: 'sse_done' });
  } catch (err) {
    parentPort!.postMessage({
      type: 'fatal',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerFatalMsg);
  }
});

initialize().catch((err) => {
  console.error('[sse-worker] Fatal initialization error:', err);
  parentPort!.postMessage({
    type: 'fatal',
    message: err instanceof Error ? err.message : String(err),
  } satisfies WorkerFatalMsg);
  process.exit(1);
});
