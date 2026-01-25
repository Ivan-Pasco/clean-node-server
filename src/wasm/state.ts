import {
  WasmState,
  WasmExports,
  RequestContext,
  WasmResponse,
  ServerConfig,
  SessionStore,
  RouteHandler,
  DatabaseDriver,
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
 * Create initial WASM state for a new instance
 */
export function createWasmState(
  instance: WebAssembly.Instance,
  config: ServerConfig,
  sessionStore: SessionStore,
  routeRegistry: RouteHandler[],
  database?: DatabaseDriver
): WasmState {
  const exports = instance.exports as unknown as WasmExports;

  if (!exports.memory) {
    throw new Error('WASM module must export memory');
  }

  if (!exports.malloc) {
    throw new Error('WASM module must export malloc function');
  }

  return {
    instance,
    exports,
    requestContext: undefined,
    response: createDefaultResponse(),
    config,
    sessionStore,
    routeRegistry,
    database,
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
