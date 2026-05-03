import * as path from 'path';
import { Worker } from 'worker_threads';
import { WasmState, SyncHttpWorker, HttpWorkerRequest, HttpWorkerResponse } from '../types';
import { readString, writeString, log } from './helpers';

const CONTROL_BYTES = 8;
const HTTP_DATA_BUFFER_SIZE = 2 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;
const IDLE = 0;
const PENDING = 1;

export class SyncHttpClient implements SyncHttpWorker {
  private worker: Worker;
  private ctrl: Int32Array;
  private dataBuf: Uint8Array;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private inFlight = false;

  constructor() {
    const controlBuffer = new SharedArrayBuffer(CONTROL_BYTES);
    const dataBuffer = new SharedArrayBuffer(HTTP_DATA_BUFFER_SIZE);

    this.ctrl = new Int32Array(controlBuffer);
    this.dataBuf = new Uint8Array(dataBuffer);

    this.worker = new Worker(path.join(__dirname, 'http-worker.js'), {
      workerData: { controlBuffer, dataBuffer },
    });

    this.worker.on('error', (err) => {
      console.error('[SyncHttpClient] Worker error:', err);
    });
  }

  private sendAndWait(request: HttpWorkerRequest): string {
    if (this.inFlight) {
      throw new Error('SyncHttpClient: re-entrant sendAndWait detected');
    }
    this.inFlight = true;
    try {
      const reqBytes = this.encoder.encode(JSON.stringify(request));
      if (reqBytes.length > HTTP_DATA_BUFFER_SIZE) {
        throw new Error(`Request payload ${reqBytes.length} bytes exceeds buffer ${HTTP_DATA_BUFFER_SIZE}`);
      }

      this.dataBuf.set(reqBytes);
      Atomics.store(this.ctrl, 1, reqBytes.length);
      Atomics.store(this.ctrl, 0, PENDING);
      this.worker.postMessage(null);

      const outcome = Atomics.wait(this.ctrl, 0, PENDING, HTTP_TIMEOUT_MS);
      if (outcome === 'timed-out') {
        Atomics.store(this.ctrl, 0, IDLE);
        throw new Error(`HTTP request timed out after ${HTTP_TIMEOUT_MS}ms`);
      }

      const respLen = Atomics.load(this.ctrl, 1);
      const json = this.decoder.decode(this.dataBuf.slice(0, respLen));
      Atomics.store(this.ctrl, 0, IDLE);
      return json;
    } finally {
      this.inFlight = false;
    }
  }

  request(opts: HttpWorkerRequest): HttpWorkerResponse {
    try {
      return JSON.parse(this.sendAndWait(opts)) as HttpWorkerResponse;
    } catch (err) {
      return { ok: false, status: 0, headers: {}, body: (err as Error).message, updatedCookies: {} };
    }
  }

  close(): void {
    void this.worker.terminate();
  }
}

function buildWorkerRequest(
  method: string,
  url: string,
  state: WasmState,
  body?: string,
  extraHeaders?: Record<string, string>
): HttpWorkerRequest {
  const client = state.httpClient;
  const cookies: Record<string, string> = {};
  for (const [k, v] of client.cookieJar) {
    cookies[k] = v;
  }
  const headers: Record<string, string> = {};
  if (client.userAgent) {
    headers['User-Agent'] = client.userAgent;
  }
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }
  return {
    method,
    url,
    body,
    headers,
    timeout: client.timeout,
    maxRedirects: client.maxRedirects,
    cookiesEnabled: client.cookiesEnabled,
    cookies,
  };
}

function applyCookieUpdates(state: WasmState, updatedCookies: Record<string, string>): void {
  if (!state.httpClient.cookiesEnabled) return;
  for (const [k, v] of Object.entries(updatedCookies)) {
    state.httpClient.cookieJar.set(k, v);
  }
}

function noWorkerError(state: WasmState): number {
  return writeString(state, JSON.stringify({
    ok: false, err: { code: 'NO_HTTP_WORKER', message: 'HTTP worker not initialised' },
  }));
}

/**
 * Create HTTP client bridge functions
 */
export function createHttpClientBridge(getState: () => WasmState) {
  return {
    http_get(urlPtr: number, urlLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      log(state, 'HTTP', `GET ${url}`);
      const resp = state.httpWorker.request(buildWorkerRequest('GET', url, state));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_post(urlPtr: number, urlLen: number, bodyPtr: number, bodyLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);
      log(state, 'HTTP', `POST ${url}`);
      const resp = state.httpWorker.request(buildWorkerRequest('POST', url, state, body));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_post_json(urlPtr: number, urlLen: number, bodyPtr: number, bodyLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);
      const resp = state.httpWorker.request(buildWorkerRequest('POST', url, state, body, { 'Content-Type': 'application/json' }));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_put(urlPtr: number, urlLen: number, bodyPtr: number, bodyLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);
      const resp = state.httpWorker.request(buildWorkerRequest('PUT', url, state, body));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_put_json(urlPtr: number, urlLen: number, bodyPtr: number, bodyLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);
      const resp = state.httpWorker.request(buildWorkerRequest('PUT', url, state, body, { 'Content-Type': 'application/json' }));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_patch(urlPtr: number, urlLen: number, bodyPtr: number, bodyLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);
      const resp = state.httpWorker.request(buildWorkerRequest('PATCH', url, state, body));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_patch_json(urlPtr: number, urlLen: number, bodyPtr: number, bodyLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);
      const resp = state.httpWorker.request(buildWorkerRequest('PATCH', url, state, body, { 'Content-Type': 'application/json' }));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_delete(urlPtr: number, urlLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const resp = state.httpWorker.request(buildWorkerRequest('DELETE', url, state));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_head(urlPtr: number, urlLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      log(state, 'HTTP', `HEAD ${url}`);
      const resp = state.httpWorker.request(buildWorkerRequest('HEAD', url, state));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, JSON.stringify(resp.headers));
    },

    http_options(urlPtr: number, urlLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      log(state, 'HTTP', `OPTIONS ${url}`);
      const resp = state.httpWorker.request(buildWorkerRequest('OPTIONS', url, state));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.headers['allow'] || resp.body);
    },

    http_get_with_headers(urlPtr: number, urlLen: number, headersPtr: number, headersLen: number): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const headersJson = readString(state, headersPtr, headersLen);
      let headers: Record<string, string> = {};
      try { headers = JSON.parse(headersJson) as Record<string, string>; } catch { /* use empty */ }
      const resp = state.httpWorker.request(buildWorkerRequest('GET', url, state, undefined, headers));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_post_with_headers(
      urlPtr: number, urlLen: number,
      bodyPtr: number, bodyLen: number,
      headersPtr: number, headersLen: number
    ): number {
      const state = getState();
      if (!state.httpWorker) return noWorkerError(state);
      const url = readString(state, urlPtr, urlLen);
      const body = readString(state, bodyPtr, bodyLen);
      const headersJson = readString(state, headersPtr, headersLen);
      let headers: Record<string, string> = {};
      try { headers = JSON.parse(headersJson) as Record<string, string>; } catch { /* use empty */ }
      log(state, 'HTTP', `POST ${url} (with headers)`);
      const resp = state.httpWorker.request(buildWorkerRequest('POST', url, state, body, headers));
      state.httpClient.lastResponse = { status: resp.status, headers: resp.headers, body: resp.body };
      applyCookieUpdates(state, resp.updatedCookies);
      return writeString(state, resp.body);
    },

    http_set_timeout(timeoutMs: number): void {
      getState().httpClient.timeout = timeoutMs;
    },

    http_set_user_agent(agentPtr: number, agentLen: number): void {
      const state = getState();
      state.httpClient.userAgent = readString(state, agentPtr, agentLen);
      log(state, 'HTTP', `User-Agent set to: ${state.httpClient.userAgent}`);
    },

    http_set_max_redirects(maxRedirects: number): void {
      getState().httpClient.maxRedirects = maxRedirects;
    },

    http_enable_cookies(enabled: number): void {
      const client = getState().httpClient;
      client.cookiesEnabled = enabled !== 0;
      if (!client.cookiesEnabled) {
        client.cookieJar.clear();
      }
    },

    http_get_response_code(): number {
      return getState().httpClient.lastResponse?.status || 0;
    },

    http_get_response_headers(): number {
      const state = getState();
      if (!state.httpClient.lastResponse) {
        return writeString(state, '{}');
      }
      return writeString(state, JSON.stringify(state.httpClient.lastResponse.headers));
    },

    http_get_response_header(namePtr: number, nameLen: number): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen).toLowerCase();
      const value = state.httpClient.lastResponse?.headers[name] || '';
      return writeString(state, value);
    },
  };
}
