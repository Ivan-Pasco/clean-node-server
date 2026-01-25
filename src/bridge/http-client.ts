import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { WasmState, HttpClientResponse } from '../types';
import { readString, writeString, log } from './helpers';

/**
 * Default HTTP timeout in milliseconds
 */
let httpTimeout = 30000;

/**
 * Last HTTP response (for accessing headers/status after request)
 */
let lastHttpResponse: HttpClientResponse | null = null;

/**
 * Make an HTTP request
 */
function makeRequest(
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>
): Promise<HttpClientResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers,
      },
      timeout: httpTimeout,
    };

    if (body) {
      (options.headers as Record<string, string | number>)['Content-Length'] = Buffer.byteLength(body);
    }

    const lib = isHttps ? https : http;

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        const responseHeaders: Record<string, string> = {};

        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') {
            responseHeaders[key] = value;
          } else if (Array.isArray(value)) {
            responseHeaders[key] = value.join(', ');
          }
        }

        resolve({
          status: res.statusCode || 0,
          headers: responseHeaders,
          body: responseBody,
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

/**
 * Create HTTP client bridge functions
 */
export function createHttpClientBridge(getState: () => WasmState) {
  return {
    /**
     * HTTP GET request
     *
     * @returns Pointer to response body string
     */
    http_get(urlPtr: number, urlLen: number): number {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);

      log(state, 'HTTP', `GET ${url}`);

      let responseBody = '';

      makeRequest('GET', url)
        .then((response) => {
          lastHttpResponse = response;
          responseBody = response.body;
        })
        .catch((err) => {
          log(state, 'HTTP', `GET failed: ${err.message}`);
          responseBody = JSON.stringify({
            ok: false,
            err: { code: 'NETWORK_FAIL', message: err.message },
          });
        });

      return writeString(state, responseBody);
    },

    /**
     * HTTP POST request
     *
     * @returns Pointer to response body string
     */
    http_post(
      urlPtr: number,
      urlLen: number,
      bodyPtr: number,
      bodyLen: number
    ): number {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);

      log(state, 'HTTP', `POST ${url}`);

      let responseBody = '';

      makeRequest('POST', url, body)
        .then((response) => {
          lastHttpResponse = response;
          responseBody = response.body;
        })
        .catch((err) => {
          log(state, 'HTTP', `POST failed: ${err.message}`);
          responseBody = JSON.stringify({
            ok: false,
            err: { code: 'NETWORK_FAIL', message: err.message },
          });
        });

      return writeString(state, responseBody);
    },

    /**
     * HTTP POST with JSON content type
     */
    http_post_json(
      urlPtr: number,
      urlLen: number,
      bodyPtr: number,
      bodyLen: number
    ): number {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);

      let responseBody = '';

      makeRequest('POST', url, body, { 'Content-Type': 'application/json' })
        .then((response) => {
          lastHttpResponse = response;
          responseBody = response.body;
        })
        .catch((err) => {
          responseBody = JSON.stringify({
            ok: false,
            err: { code: 'NETWORK_FAIL', message: err.message },
          });
        });

      return writeString(state, responseBody);
    },

    /**
     * HTTP PUT request
     */
    http_put(
      urlPtr: number,
      urlLen: number,
      bodyPtr: number,
      bodyLen: number
    ): number {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);

      let responseBody = '';

      makeRequest('PUT', url, body)
        .then((response) => {
          lastHttpResponse = response;
          responseBody = response.body;
        })
        .catch((err) => {
          responseBody = JSON.stringify({
            ok: false,
            err: { code: 'NETWORK_FAIL', message: err.message },
          });
        });

      return writeString(state, responseBody);
    },

    /**
     * HTTP PATCH request
     */
    http_patch(
      urlPtr: number,
      urlLen: number,
      bodyPtr: number,
      bodyLen: number
    ): number {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);

      let responseBody = '';

      makeRequest('PATCH', url, body)
        .then((response) => {
          lastHttpResponse = response;
          responseBody = response.body;
        })
        .catch((err) => {
          responseBody = JSON.stringify({
            ok: false,
            err: { code: 'NETWORK_FAIL', message: err.message },
          });
        });

      return writeString(state, responseBody);
    },

    /**
     * HTTP DELETE request
     */
    http_delete(urlPtr: number, urlLen: number): number {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);

      let responseBody = '';

      makeRequest('DELETE', url)
        .then((response) => {
          lastHttpResponse = response;
          responseBody = response.body;
        })
        .catch((err) => {
          responseBody = JSON.stringify({
            ok: false,
            err: { code: 'NETWORK_FAIL', message: err.message },
          });
        });

      return writeString(state, responseBody);
    },

    /**
     * HTTP GET with custom headers
     */
    http_get_with_headers(
      urlPtr: number,
      urlLen: number,
      headersPtr: number,
      headersLen: number
    ): number {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);
      const headersJson = readString(state, headersPtr, headersLen);

      let headers: Record<string, string> = {};
      try {
        headers = JSON.parse(headersJson);
      } catch {
        // Use empty headers
      }

      let responseBody = '';

      makeRequest('GET', url, undefined, headers)
        .then((response) => {
          lastHttpResponse = response;
          responseBody = response.body;
        })
        .catch((err) => {
          responseBody = JSON.stringify({
            ok: false,
            err: { code: 'NETWORK_FAIL', message: err.message },
          });
        });

      return writeString(state, responseBody);
    },

    /**
     * Set HTTP timeout
     */
    http_set_timeout(timeoutMs: number): void {
      httpTimeout = timeoutMs;
    },

    /**
     * Get response status code from last request
     */
    http_get_response_code(): number {
      return lastHttpResponse?.status || 0;
    },

    /**
     * Get response headers from last request as JSON
     */
    http_get_response_headers(): number {
      const state = getState();
      if (!lastHttpResponse) {
        return writeString(state, '{}');
      }
      return writeString(state, JSON.stringify(lastHttpResponse.headers));
    },

    /**
     * Get a specific response header from last request
     */
    http_get_response_header(namePtr: number, nameLen: number): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen).toLowerCase();

      if (!lastHttpResponse) {
        return writeString(state, '');
      }

      // Headers are typically lowercase
      const value = lastHttpResponse.headers[name] || '';
      return writeString(state, value);
    },
  };
}
