import {
  WasmState,
  WasmExports,
  RequestContext,
  WasmResponse,
  ServerConfig,
  SessionStore,
  RouteHandler,
  DatabaseDriver,
  MemoryStats,
  SyncHttpWorker,
} from '../types';

/**
 * Default response state
 */
function createDefaultResponse(): WasmResponse {
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
    body: '',
    cookies: [],
  };
}

/**
 * Read the `__heap_ptr` global exported by the WASM module.
 * Spec: MEMORY_POLICY.md §7.2 — the module's `__heap_ptr` export is the
 * authoritative heap start. Falls back to 65,536 for modules predating this contract.
 */
function readInitialHeapPtr(instance: WebAssembly.Instance): number {
  const global = (instance.exports as Record<string, unknown>).__heap_ptr;
  if (global && typeof (global as WebAssembly.Global).value === 'number') {
    return (global as WebAssembly.Global).value as number;
  }
  return 65536;
}

/**
 * Wrap `malloc` to track memory stats (grow count, peak allocation) and
 * enforce the `memoryLimitBytes` cap from ServerConfig.
 *
 * Spec: MEMORY_POLICY.md §9.4 (per-request observability) and the
 * clean-node-server task 3 (memory-limit CLI flag).
 */
function wrapMalloc(exports: WasmExports, stats: MemoryStats, config: ServerConfig): void {
  const originalMalloc = exports.malloc;

  // Object.create shadows the prototype but [[Set]] still throws when the
  // prototype property is non-writable. Object.defineProperty creates an OWN
  // property on the shadow object directly, bypassing the prototype chain check.
  Object.defineProperty(exports, 'malloc', {
    value: (size: number): number => {
      const beforeBytes = exports.memory.buffer.byteLength;

      if (config.memoryLimitBytes !== undefined && beforeBytes + size > config.memoryLimitBytes) {
        stats.oomCount++;
        if (config.verbose) {
          const ts = new Date().toISOString();
          console.warn(
            `[${ts}] [MEM] allocation of ${size} bytes denied: would exceed limit ${config.memoryLimitBytes} (current ${beforeBytes})`
          );
        }
        return 0;
      }

      const ptr = originalMalloc(size);
      const afterBytes = exports.memory.buffer.byteLength;

      if (afterBytes > beforeBytes) {
        stats.growCount++;
      }
      if (afterBytes > stats.peakMemorySize) {
        stats.peakMemorySize = afterBytes;
      }
      if (ptr > 0) {
        stats.allocCount++;
        const top = ptr + size;
        if (top > stats.peakAllocation) {
          stats.peakAllocation = top;
        }
      }

      return ptr;
    },
    writable: true,
    configurable: true,
  });
}

/**
 * Create initial WASM state for a new instance
 */
export function createWasmState(
  instance: WebAssembly.Instance,
  config: ServerConfig,
  sessionStore: SessionStore,
  routeRegistry: RouteHandler[],
  database?: DatabaseDriver,
  httpWorker?: SyncHttpWorker
): WasmState {
  // Node.js v22 enforces WASM exports as non-writable (per spec). Shadow the
  // exports object so wrapMalloc can install its wrapper via Object.defineProperty
  // while all other exports remain accessible via the prototype chain.
  const exports = Object.create(instance.exports) as unknown as WasmExports;

  if (!exports.memory) {
    throw new Error('WASM module must export memory');
  }

  if (!exports.malloc) {
    throw new Error('WASM module must export malloc function');
  }

  const initialHeapPtr = readInitialHeapPtr(instance);
  const initialMemorySize = exports.memory.buffer.byteLength;

  const memoryStats: MemoryStats = {
    initialMemorySize,
    peakMemorySize: initialMemorySize,
    initialHeapPtr,
    peakAllocation: initialHeapPtr,
    growCount: 0,
    allocCount: 0,
    oomCount: 0,
  };

  wrapMalloc(exports, memoryStats, config);

  return {
    instance,
    exports,
    requestContext: undefined,
    response: createDefaultResponse(),
    config,
    sessionStore,
    routeRegistry,
    database,
    memoryStats,
    httpClient: {
      timeout: 30000,
      userAgent: null,
      maxRedirects: 5,
      cookiesEnabled: false,
      cookieJar: new Map(),
      lastResponse: null,
    },
    httpWorker,
  };
}

/**
 * Set request context for a WASM state instance
 */
export function setRequestContext(state: WasmState, context: RequestContext): void {
  state.requestContext = context;
  state.response = createDefaultResponse();
}

/**
 * Get current request context (throws if not set)
 */
export function getRequestContext(state: WasmState): RequestContext {
  if (!state.requestContext) {
    throw new Error('Request context not set - this bridge function can only be called during request handling');
  }
  return state.requestContext;
}

/**
 * Set response status code
 */
export function setResponseStatus(state: WasmState, status: number): void {
  state.response.status = status;
}

/**
 * Set response header
 */
export function setResponseHeader(state: WasmState, name: string, value: string): void {
  state.response.headers[name] = value;
}

/**
 * Set response body
 */
export function setResponseBody(state: WasmState, body: string): void {
  state.response.body = body;
}

/**
 * Add a cookie to the response
 */
export function addResponseCookie(
  state: WasmState,
  name: string,
  value: string,
  options?: {
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
    path?: string;
  }
): void {
  if (!state.response.cookies) {
    state.response.cookies = [];
  }
  state.response.cookies.push({ name, value, options });
}

/**
 * Get the response to send back to the client
 */
export function getResponse(state: WasmState): WasmResponse {
  return state.response;
}
