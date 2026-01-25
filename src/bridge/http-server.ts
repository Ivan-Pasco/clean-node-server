import { WasmState } from '../types';
import { readString, log } from './helpers';
import { RouteRegistry } from '../router';

/**
 * Shared route registry (populated during WASM start())
 */
let sharedRouteRegistry: RouteRegistry | null = null;
let configuredPort: number = 3000;

/**
 * Set the shared route registry
 */
export function setRouteRegistry(registry: RouteRegistry): void {
  sharedRouteRegistry = registry;
}

/**
 * Get the shared route registry
 */
export function getRouteRegistry(): RouteRegistry {
  if (!sharedRouteRegistry) {
    sharedRouteRegistry = new RouteRegistry();
  }
  return sharedRouteRegistry;
}

/**
 * Get the configured port
 */
export function getConfiguredPort(): number {
  return configuredPort;
}

/**
 * Create HTTP server bridge functions
 */
export function createHttpServerBridge(getState: () => WasmState) {
  return {
    /**
     * Set the port to listen on
     */
    _http_listen(port: number): void {
      const state = getState();
      configuredPort = port;
      log(state, 'HTTP', `Port configured: ${port}`);
    },

    /**
     * Register a route handler
     */
    _http_route(
      methodPtr: number,
      methodLen: number,
      pathPtr: number,
      pathLen: number,
      handlerIndex: number
    ): void {
      const state = getState();
      const method = readString(state, methodPtr, methodLen);
      const path = readString(state, pathPtr, pathLen);

      const registry = getRouteRegistry();
      registry.register(method, path, handlerIndex, false);

      log(state, 'HTTP', `Route registered: ${method} ${path} -> handler_${handlerIndex}`);
    },

    /**
     * Register a protected route handler (requires authentication)
     */
    _http_route_protected(
      methodPtr: number,
      methodLen: number,
      pathPtr: number,
      pathLen: number,
      handlerIndex: number,
      rolePtr: number,
      roleLen: number
    ): void {
      const state = getState();
      const method = readString(state, methodPtr, methodLen);
      const path = readString(state, pathPtr, pathLen);
      const requiredRole = roleLen > 0 ? readString(state, rolePtr, roleLen) : undefined;

      const registry = getRouteRegistry();
      registry.register(method, path, handlerIndex, true, requiredRole);

      log(
        state,
        'HTTP',
        `Protected route registered: ${method} ${path} -> handler_${handlerIndex} (role: ${requiredRole || 'any'})`
      );
    },

    /**
     * Set response status code
     */
    _http_set_status(status: number): void {
      const state = getState();
      state.response.status = status;
    },

    /**
     * Set response header
     */
    _http_set_header(
      namePtr: number,
      nameLen: number,
      valuePtr: number,
      valueLen: number
    ): void {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      const value = readString(state, valuePtr, valueLen);
      state.response.headers[name] = value;
    },

    /**
     * Set response body
     */
    _http_set_body(ptr: number, len: number): void {
      const state = getState();
      state.response.body = readString(state, ptr, len);
    },

    /**
     * Set JSON response (convenience function)
     */
    _http_json(ptr: number, len: number): void {
      const state = getState();
      state.response.headers['Content-Type'] = 'application/json';
      state.response.body = readString(state, ptr, len);
    },

    /**
     * Set HTML response
     */
    _http_html(ptr: number, len: number): void {
      const state = getState();
      state.response.headers['Content-Type'] = 'text/html; charset=utf-8';
      state.response.body = readString(state, ptr, len);
    },

    /**
     * Set plain text response
     */
    _http_text(ptr: number, len: number): void {
      const state = getState();
      state.response.headers['Content-Type'] = 'text/plain; charset=utf-8';
      state.response.body = readString(state, ptr, len);
    },

    /**
     * Redirect to another URL
     */
    _http_redirect(
      urlPtr: number,
      urlLen: number,
      permanent: number
    ): void {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);
      state.response.status = permanent ? 301 : 302;
      state.response.headers['Location'] = url;
      state.response.body = '';
    },

    /**
     * Set 404 Not Found response
     */
    _http_not_found(messagePtr: number, messageLen: number): void {
      const state = getState();
      const message = messageLen > 0 ? readString(state, messagePtr, messageLen) : 'Not Found';
      state.response.status = 404;
      state.response.headers['Content-Type'] = 'application/json';
      state.response.body = JSON.stringify({
        ok: false,
        err: { code: 'NOT_FOUND', message },
      });
    },

    /**
     * Set 400 Bad Request response
     */
    _http_bad_request(messagePtr: number, messageLen: number): void {
      const state = getState();
      const message = messageLen > 0 ? readString(state, messagePtr, messageLen) : 'Bad Request';
      state.response.status = 400;
      state.response.headers['Content-Type'] = 'application/json';
      state.response.body = JSON.stringify({
        ok: false,
        err: { code: 'BAD_REQUEST', message },
      });
    },

    /**
     * Set 401 Unauthorized response
     */
    _http_unauthorized(messagePtr: number, messageLen: number): void {
      const state = getState();
      const message = messageLen > 0 ? readString(state, messagePtr, messageLen) : 'Unauthorized';
      state.response.status = 401;
      state.response.headers['Content-Type'] = 'application/json';
      state.response.body = JSON.stringify({
        ok: false,
        err: { code: 'AUTH_ERROR', message },
      });
    },

    /**
     * Set 403 Forbidden response
     */
    _http_forbidden(messagePtr: number, messageLen: number): void {
      const state = getState();
      const message = messageLen > 0 ? readString(state, messagePtr, messageLen) : 'Forbidden';
      state.response.status = 403;
      state.response.headers['Content-Type'] = 'application/json';
      state.response.body = JSON.stringify({
        ok: false,
        err: { code: 'PERMISSION_DENIED', message },
      });
    },

    /**
     * Set 500 Internal Server Error response
     */
    _http_server_error(messagePtr: number, messageLen: number): void {
      const state = getState();
      const message = messageLen > 0 ? readString(state, messagePtr, messageLen) : 'Internal Server Error';
      state.response.status = 500;
      state.response.headers['Content-Type'] = 'application/json';
      state.response.body = JSON.stringify({
        ok: false,
        err: { code: 'INTERNAL_ERROR', message },
      });
    },

    /**
     * Combined function to set status, content-type, and body in one call
     * Returns the body for convenience
     */
    _http_respond(
      status: number,
      contentTypePtr: number,
      contentTypeLen: number,
      bodyPtr: number,
      bodyLen: number
    ): number {
      const state = getState();
      const contentType = readString(state, contentTypePtr, contentTypeLen);
      const body = readString(state, bodyPtr, bodyLen);

      state.response.status = status;
      state.response.headers['Content-Type'] = contentType;
      state.response.body = body;

      // Return a pointer to indicate success (0 for success)
      return 0;
    },
  };
}
