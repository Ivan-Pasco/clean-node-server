import { WasmState } from '../types';
import { readString, writeString } from './helpers';
import { getRouteRegistry } from './http-server';
import { setRequestContext, getResponse } from '../wasm/state';
import { readLengthPrefixedString } from '../wasm/memory';
import { parseUrl } from '../router';

interface TestResponse {
  status: number;
  body: string;
}

let nextHandle = 0;
const responseStore = new Map<number, TestResponse>();

export function resetTestBridge(): void {
  nextHandle = 0;
  responseStore.clear();
}

export function createTestBridge(getState: () => WasmState) {
  return {
    // Params: 5 raw (ptr, len) pairs matching the compiler's WASM emission and
    // clean-server/src/bridge.rs. NOT length-prefixed pointers.
    // Signature: (method_ptr, method_len, path_ptr, path_len, body_ptr, body_len,
    //             hkey_ptr, hkey_len, hval_ptr, hval_len) -> handle i32
    _test_http_request(
      methodPtr: number, methodLen: number,
      pathPtr: number, pathLen: number,
      bodyPtr: number, bodyLen: number,
      headerKeyPtr: number, headerKeyLen: number,
      headerValuePtr: number, headerValueLen: number
    ): number {
      const state = getState();
      const method = readString(state, methodPtr, methodLen);
      const rawPath = readString(state, pathPtr, pathLen);
      const body = readString(state, bodyPtr, bodyLen);
      const headerKey = readString(state, headerKeyPtr, headerKeyLen);
      const headerValue = readString(state, headerValuePtr, headerValueLen);

      const { path, query } = parseUrl(rawPath);
      const registry = getRouteRegistry();
      const match = registry.match(method, path);

      if (!match) return -1;

      const headers: Record<string, string> = {};
      if (headerKey) headers[headerKey] = headerValue;

      setRequestContext(state, {
        method: method.toUpperCase(),
        path,
        params: match.params,
        query,
        headers,
        body,
        cookies: {},
      });

      // Reset per-request mutable state the same way the request worker does
      state.httpClient = {
        timeout: 30000,
        userAgent: null,
        maxRedirects: 5,
        cookiesEnabled: false,
        cookieJar: new Map(),
        lastResponse: null,
      };
      state.injectedCss = undefined;

      const handlerName = match.route.handlerName;
      const handler = state.exports[handlerName];
      if (typeof handler !== 'function') return -1;

      try {
        const resultPtr = (handler as () => number)();
        if (resultPtr > 0) {
          const responseBody = readLengthPrefixedString(state.exports.memory, resultPtr);
          if (responseBody) state.response.body = responseBody;
        }
      } catch {
        return -1;
      }

      const response = getResponse(state);
      const handle = nextHandle++;
      responseStore.set(handle, { status: response.status, body: response.body });
      return handle;
    },

    _test_response_status(handle: number): number {
      const entry = responseStore.get(handle);
      return entry !== undefined ? entry.status : -1;
    },

    _test_response_body(handle: number): number {
      const state = getState();
      const entry = responseStore.get(handle);
      return writeString(state, entry !== undefined ? entry.body : '');
    },
  };
}
