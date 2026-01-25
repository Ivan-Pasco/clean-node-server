import { WasmState } from '../types';
import { readString, writeString } from './helpers';
import { getRequestContext } from '../wasm/state';

/**
 * Create request context bridge functions
 *
 * These functions allow WASM handlers to access request data
 */
export function createRequestBridge(getState: () => WasmState) {
  return {
    /**
     * Get request method (GET, POST, etc.)
     */
    _req_method(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return writeString(state, ctx.method);
    },

    /**
     * Get request path
     */
    _req_path(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return writeString(state, ctx.path);
    },

    /**
     * Get a URL parameter by name
     */
    _req_param(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen);
      return writeString(state, ctx.params[name] || '');
    },

    /**
     * Get all URL parameters as JSON
     */
    _req_params(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return writeString(state, JSON.stringify(ctx.params));
    },

    /**
     * Get a query string parameter by name
     */
    _req_query(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen);
      return writeString(state, ctx.query[name] || '');
    },

    /**
     * Get all query string parameters as JSON
     */
    _req_queries(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return writeString(state, JSON.stringify(ctx.query));
    },

    /**
     * Get request body as string
     */
    _req_body(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return writeString(state, ctx.body);
    },

    /**
     * Get request body parsed as JSON (returns JSON string or empty)
     */
    _req_json(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      try {
        // Validate it's valid JSON, then return it
        JSON.parse(ctx.body);
        return writeString(state, ctx.body);
      } catch {
        return writeString(state, '');
      }
    },

    /**
     * Get a request header by name
     */
    _req_header(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen).toLowerCase();

      // Headers are stored lowercase
      const value = ctx.headers[name] || '';
      return writeString(state, value);
    },

    /**
     * Get all request headers as JSON
     */
    _req_headers(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return writeString(state, JSON.stringify(ctx.headers));
    },

    /**
     * Get a cookie by name
     */
    _req_cookie(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen);
      return writeString(state, ctx.cookies[name] || '');
    },

    /**
     * Get all cookies as JSON
     */
    _req_cookies(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return writeString(state, JSON.stringify(ctx.cookies));
    },

    /**
     * Check if a header exists
     */
    _req_has_header(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen).toLowerCase();
      return name in ctx.headers ? 1 : 0;
    },

    /**
     * Check if a query parameter exists
     */
    _req_has_query(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen);
      return name in ctx.query ? 1 : 0;
    },

    /**
     * Check if a cookie exists
     */
    _req_has_cookie(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen);
      return name in ctx.cookies ? 1 : 0;
    },

    /**
     * Get content type header
     */
    _req_content_type(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return writeString(state, ctx.headers['content-type'] || '');
    },

    /**
     * Check if request is JSON
     */
    _req_is_json(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const contentType = ctx.headers['content-type'] || '';
      return contentType.includes('application/json') ? 1 : 0;
    },

    /**
     * Get the Authorization header value (without Bearer prefix)
     */
    _req_auth_token(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const auth = ctx.headers['authorization'] || '';

      if (auth.startsWith('Bearer ')) {
        return writeString(state, auth.slice(7));
      }

      return writeString(state, '');
    },

    /**
     * Check if request has Authorization header
     */
    _req_has_auth(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      return 'authorization' in ctx.headers ? 1 : 0;
    },

    /**
     * Get a specific field from the JSON request body
     */
    _req_body_field(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen);

      // Parse body as JSON and extract field
      const body = ctx.body;
      if (!body) return writeString(state, '');

      try {
        const json = typeof body === 'string' ? JSON.parse(body) : body;
        const value = json[name];
        return writeString(state, value?.toString() ?? '');
      } catch {
        return writeString(state, '');
      }
    },

    /**
     * Get a route parameter as an integer
     */
    _req_param_int(namePtr: number, nameLen: number): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const name = readString(state, namePtr, nameLen);

      const value = ctx.params[name];
      if (value === undefined) return 0;

      const num = parseInt(value, 10);
      return isNaN(num) ? 0 : num;
    },
  };
}
