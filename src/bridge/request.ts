import { createHash } from 'node:crypto';
import { WasmState } from '../types';
import { readString, writeString, writeBytes } from './helpers';
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
     * Get the raw request body as an opaque byte sequence.
     *
     * Returns the pointer to a length-prefixed byte buffer laid out exactly
     * like a length-prefixed string (`[4-byte LE length][bytes]`). No UTF-8
     * decoding is performed, so binary payloads (tarballs, images, arbitrary
     * octets) are preserved verbatim — the caller can compute a hash over
     * the exact wire bytes, write them to disk, or forward them untouched.
     *
     * When `Content-Length` is set on the request, the returned length is
     * guaranteed to equal it. Empty bodies return a pointer to a zero-length
     * buffer, not 0.
     *
     * Backed by ctx.bodyBytes when the server buffered raw bytes (see
     * `express.raw` middleware for `application/octet-stream`). Falls back
     * to the UTF-8 encoding of `ctx.body` for content-types the raw parser
     * did not intercept — in that path the bytes are already textual, so
     * the encoding is exact.
     */
    _req_body_bytes(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const bytes = ctx.bodyBytes ?? new TextEncoder().encode(ctx.body);
      return writeBytes(state, bytes);
    },

    /**
     * Server-computed SHA-256 (lowercase hex) of the raw request body,
     * hashed over the pre-parse bytes so callers can compare against a
     * client-supplied X-Tarball-SHA256 (or similar) without needing to
     * materialize the body inside WASM linear memory.
     *
     * Same byte source as _req_body_bytes: ctx.bodyBytes when the raw
     * middleware buffered them, else the UTF-8 encoding of ctx.body.
     */
    _req_body_sha256_hex(): number {
      const state = getState();
      const ctx = getRequestContext(state);
      const bytes = ctx.bodyBytes ?? new TextEncoder().encode(ctx.body);
      const hex = createHash('sha256').update(bytes).digest('hex');
      return writeString(state, hex);
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

    /**
     * Parse form-urlencoded POST body as JSON
     */
    _req_form(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      // Parse body as form-urlencoded data
      const body = ctx.body;
      if (!body) return writeString(state, '{}');

      try {
        const params = new URLSearchParams(body);
        const result: Record<string, string> = {};

        // Convert URLSearchParams to object
        params.forEach((value, key) => {
          result[key] = value;
        });

        return writeString(state, JSON.stringify(result));
      } catch {
        return writeString(state, '{}');
      }
    },

    /**
     * Get client IP address
     */
    _req_ip(): number {
      const state = getState();
      const ctx = getRequestContext(state);

      // Check X-Forwarded-For header first (take first IP if comma-separated)
      const forwardedFor = ctx.headers['x-forwarded-for'];
      if (forwardedFor) {
        const firstIp = forwardedFor.split(',')[0].trim();
        return writeString(state, firstIp);
      }

      // Fall back to X-Real-IP header
      const realIp = ctx.headers['x-real-ip'];
      if (realIp) {
        return writeString(state, realIp);
      }

      // Return "unknown" if no header found
      return writeString(state, 'unknown');
    },
  };
}
