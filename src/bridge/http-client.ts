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
 * Custom User-Agent header
 */
let httpUserAgent: string | null = null;

/**
 * Maximum number of redirects to follow
 */
let httpMaxRedirects = 5;

/**
 * Whether cookies are enabled
 */
let httpCookiesEnabled = false;

/**
 * Cookie storage (simple key-value for same-origin)
 */
const cookieJar: Map<string, string> = new Map();

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
  headers?: Record<string, string>,
  redirectCount = 0
): Promise<HttpClientResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const origin = parsedUrl.origin;

    const requestHeaders: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...headers,
    };

    // Apply custom User-Agent if set
    if (httpUserAgent) {
      requestHeaders['User-Agent'] = httpUserAgent;
    }

    // Apply cookies if enabled
    if (httpCookiesEnabled && cookieJar.size > 0) {
      const cookies: string[] = [];
      for (const [name, value] of cookieJar) {
        cookies.push(`${name}=${value}`);
      }
      if (cookies.length > 0) {
        requestHeaders['Cookie'] = cookies.join('; ');
      }
    }

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: requestHeaders,
      timeout: httpTimeout,
    };

    if (body) {
      requestHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const lib = isHttps ? https : http;

    const req = lib.request(options, (res) => {
      // Handle redirects
      if (
        res.statusCode &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location &&
        redirectCount < httpMaxRedirects
      ) {
        const redirectUrl = new URL(res.headers.location, url).href;
        // For 303, always use GET; for others, maintain method (307, 308) or use GET (301, 302)
        const redirectMethod =
          res.statusCode === 303 || res.statusCode === 301 || res.statusCode === 302
            ? 'GET'
            : method;
        const redirectBody =
          res.statusCode === 303 || res.statusCode === 301 || res.statusCode === 302
            ? undefined
            : body;

        makeRequest(redirectMethod, redirectUrl, redirectBody, headers, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

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

        // Store cookies if enabled
        if (httpCookiesEnabled && res.headers['set-cookie']) {
          const setCookies = res.headers['set-cookie'];
          for (const cookie of setCookies) {
            const [nameValue] = cookie.split(';');
            const [name, value] = nameValue.split('=');
            if (name && value) {
              cookieJar.set(name.trim(), value.trim());
            }
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
     * HTTP POST with custom headers
     */
    http_post_with_headers(
      urlPtr: number,
      urlLen: number,
      bodyPtr: number,
      bodyLen: number,
      headersPtr: number,
      headersLen: number
    ): number {
      const state = getState();
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);
      const headersJson = readString(state, headersPtr, headersLen);

      let headers: Record<string, string> = {};
      try {
        headers = JSON.parse(headersJson);
      } catch {
        // Use empty headers
      }

      log(state, 'HTTP', `POST ${url} (with headers)`);

      let responseBody = '';

      makeRequest('POST', url, body, headers)
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
     * Set HTTP timeout
     */
    http_set_timeout(timeoutMs: number): void {
      httpTimeout = timeoutMs;
    },

    /**
     * Set custom User-Agent header for all requests
     */
    http_set_user_agent(agentPtr: number, agentLen: number): void {
      const state = getState();
      httpUserAgent = readString(state, agentPtr, agentLen);
      log(state, 'HTTP', `User-Agent set to: ${httpUserAgent}`);
    },

    /**
     * Set maximum number of redirects to follow
     */
    http_set_max_redirects(maxRedirects: number): void {
      httpMaxRedirects = maxRedirects;
    },

    /**
     * Enable or disable cookie handling
     */
    http_enable_cookies(enabled: number): void {
      httpCookiesEnabled = enabled !== 0;
      if (!httpCookiesEnabled) {
        cookieJar.clear();
      }
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
