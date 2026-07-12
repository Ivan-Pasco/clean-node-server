/**
 * HTTP client bridge tests — createHttpClientBridge
 *
 * Alignment: positive-path contract for method surface, setter side-effects,
 *   and no-worker error path.
 * Category: contract
 *
 * No real HTTP server or worker is used. Tests verify:
 *   1. The bridge object exposes all documented methods.
 *   2. Setter methods (http_set_timeout, http_set_user_agent,
 *      http_set_max_redirects, http_enable_cookies) mutate state correctly.
 *   3. Getter accessors (http_get_response_code, http_get_response_headers,
 *      http_get_response_body, http_get_response_header) return safe defaults
 *      when no response has been stored.
 *   4. Request methods (http_get, http_post, etc.) return a graceful error
 *      JSON when httpWorker is not wired.
 */

import { describe, it, expect } from 'vitest';
import { createHttpClientBridge } from '../src/bridge/http-client';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState, HttpClientState } from '../src/types';

// ─── Test helpers ────────────────────────────────────────────────────────────

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

function makeMockState(memory?: WebAssembly.Memory, heapStart = 65_536): WasmState {
  const mem = memory ?? new WebAssembly.Memory({ initial: 4 });
  let heapPtr = heapStart;
  const exports = {
    memory: mem,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  const httpClient: HttpClientState = {
    timeout: 30_000,
    userAgent: null,
    maxRedirects: 5,
    cookiesEnabled: false,
    cookieJar: new Map(),
    lastResponse: null,
  };
  return {
    exports,
    config: { verbose: false },
    projectRoot: '/tmp',
    httpClient,
    httpWorker: undefined, // no worker — error path
  } as unknown as WasmState;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('HTTP client bridge — method surface', () => {
  it('bridge exposes all documented request methods', () => {
    const state = makeMockState();
    const bridge = createHttpClientBridge(() => state);

    const methods = [
      'http_get',
      'http_post',
      'http_post_json',
      'http_put',
      'http_put_json',
      'http_patch',
      'http_patch_json',
      'http_delete',
      'http_head',
      'http_options',
      'http_get_with_headers',
      'http_post_with_headers',
      'http_put_with_headers',
      'http_patch_with_headers',
      'http_delete_with_headers',
    ];

    for (const m of methods) {
      expect(typeof (bridge as Record<string, unknown>)[m], `method ${m}`).toBe('function');
    }
  });

  it('bridge exposes all documented setter and accessor methods', () => {
    const state = makeMockState();
    const bridge = createHttpClientBridge(() => state);

    const methods = [
      'http_set_timeout',
      'http_set_user_agent',
      'http_set_max_redirects',
      'http_enable_cookies',
      'http_get_response_code',
      'http_get_response_headers',
      'http_get_response_header',
      'http_get_response_body',
    ];

    for (const m of methods) {
      expect(typeof (bridge as Record<string, unknown>)[m], `method ${m}`).toBe('function');
    }
  });
});

describe('HTTP client bridge — setter side-effects on state', () => {
  it('http_set_timeout updates state.httpClient.timeout', () => {
    const state = makeMockState();
    const bridge = createHttpClientBridge(() => state);

    bridge.http_set_timeout(5_000);
    expect(state.httpClient.timeout).toBe(5_000);

    bridge.http_set_timeout(0);
    expect(state.httpClient.timeout).toBe(0);
  });

  it('http_set_max_redirects updates state.httpClient.maxRedirects', () => {
    const state = makeMockState();
    const bridge = createHttpClientBridge(() => state);

    bridge.http_set_max_redirects(10);
    expect(state.httpClient.maxRedirects).toBe(10);

    bridge.http_set_max_redirects(0);
    expect(state.httpClient.maxRedirects).toBe(0);
  });

  it('http_set_user_agent writes string to state.httpClient.userAgent', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createHttpClientBridge(() => state);

    const agentStr = 'CleanBot/1.0';
    const len = writeRawAt(memory, 128, agentStr);
    bridge.http_set_user_agent(128, len);
    expect(state.httpClient.userAgent).toBe(agentStr);
  });

  it('http_enable_cookies(1) sets cookiesEnabled=true; http_enable_cookies(0) clears jar', () => {
    const state = makeMockState();
    const bridge = createHttpClientBridge(() => state);

    bridge.http_enable_cookies(1);
    expect(state.httpClient.cookiesEnabled).toBe(true);

    // Manually add a cookie to the jar
    state.httpClient.cookieJar.set('session', 'abc');
    expect(state.httpClient.cookieJar.size).toBe(1);

    // Disabling cookies should clear the jar
    bridge.http_enable_cookies(0);
    expect(state.httpClient.cookiesEnabled).toBe(false);
    expect(state.httpClient.cookieJar.size).toBe(0);
  });
});

describe('HTTP client bridge — accessor defaults (no response stored)', () => {
  it('http_get_response_code returns 0 when no request has been made', () => {
    const state = makeMockState();
    const bridge = createHttpClientBridge(() => state);
    expect(bridge.http_get_response_code()).toBe(0);
  });

  it('http_get_response_headers returns LP-string "{}" when no response', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createHttpClientBridge(() => state);

    const ptr = bridge.http_get_response_headers();
    const result = readLengthPrefixedString(memory, ptr);
    expect(result).toBe('{}');
  });

  it('http_get_response_body returns empty LP-string when no response', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createHttpClientBridge(() => state);

    const ptr = bridge.http_get_response_body();
    const result = readLengthPrefixedString(memory, ptr);
    expect(result).toBe('');
  });

  it('http_get_response_header returns empty LP-string for any header name', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createHttpClientBridge(() => state);

    const nameLen = writeRawAt(memory, 64, 'content-type');
    const ptr = bridge.http_get_response_header(64, nameLen);
    const result = readLengthPrefixedString(memory, ptr);
    expect(result).toBe('');
  });
});

describe('HTTP client bridge — graceful error when worker is absent', () => {
  it('http_get returns LP-string with NO_HTTP_WORKER error when httpWorker is undefined', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createHttpClientBridge(() => state);

    const urlLen = writeRawAt(memory, 200, 'https://example.com');
    const ptr = bridge.http_get(200, urlLen);
    const body = readLengthPrefixedString(memory, ptr);

    const parsed = JSON.parse(body) as { ok: boolean; err: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.err.code).toBe('NO_HTTP_WORKER');
  });

  it('http_post returns NO_HTTP_WORKER error and does not throw', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createHttpClientBridge(() => state);

    const urlLen = writeRawAt(memory, 200, 'https://api.example.com/data');
    const bodyLen = writeRawAt(memory, 300, '{"key":"val"}');
    const ptr = bridge.http_post(200, urlLen, 300, bodyLen);
    const resp = readLengthPrefixedString(memory, ptr);

    const parsed = JSON.parse(resp) as { ok: boolean; err: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.err.code).toBe('NO_HTTP_WORKER');
  });

  it('http_delete returns NO_HTTP_WORKER error without throwing', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createHttpClientBridge(() => state);

    const urlLen = writeRawAt(memory, 200, 'https://api.example.com/item/1');
    expect(() => {
      const ptr = bridge.http_delete(200, urlLen);
      const resp = readLengthPrefixedString(memory, ptr);
      const parsed = JSON.parse(resp) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }).not.toThrow();
  });
});
