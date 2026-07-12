/**
 * Request bridge tests — createRequestBridge
 *
 * Alignment: positive-path contract for all request context accessors.
 * Category: contract
 *
 * Tests cover:
 *   - All accessors return correct values from a populated RequestContext
 *   - _req_json validates JSON and returns empty for non-JSON bodies
 *   - _req_auth_token strips the "Bearer " prefix
 *   - _req_form parses URL-encoded bodies
 *   - _req_ip reads X-Forwarded-For then X-Real-IP then falls back to "unknown"
 *   - _req_has_header / _req_has_query / _req_has_cookie return 1/0 correctly
 *   - Bridge throws the expected error when no request context is set
 */

import { describe, it, expect } from 'vitest';
import { createRequestBridge } from '../src/bridge/request';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState, RequestContext } from '../src/types';

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
  return { exports, config: { verbose: false }, projectRoot: '/tmp' } as unknown as WasmState;
}

function makeStateWithContext(
  memory: WebAssembly.Memory,
  ctx: RequestContext,
  heapStart = 65_536
): WasmState {
  const state = makeMockState(memory, heapStart);
  state.requestContext = ctx;
  return state;
}

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    method: 'GET',
    path: '/test',
    params: {},
    query: {},
    headers: {},
    body: '',
    cookies: {},
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Request bridge — throws when no context is set', () => {
  it('_req_method throws if requestContext is undefined', () => {
    const state = makeMockState();
    const bridge = createRequestBridge(() => state);
    expect(() => bridge._req_method()).toThrow();
  });

  it('_req_body throws if requestContext is undefined', () => {
    const state = makeMockState();
    const bridge = createRequestBridge(() => state);
    expect(() => bridge._req_body()).toThrow();
  });
});

describe('Request bridge — method, path, and body accessors', () => {
  it('_req_method returns the HTTP method from context', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({ method: 'POST' }));
    const bridge = createRequestBridge(() => state);

    const ptr = bridge._req_method();
    expect(readLengthPrefixedString(memory, ptr)).toBe('POST');
  });

  it('_req_path returns the request path', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({ path: '/users/42' }));
    const bridge = createRequestBridge(() => state);

    const ptr = bridge._req_path();
    expect(readLengthPrefixedString(memory, ptr)).toBe('/users/42');
  });

  it('_req_body returns the raw body string', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const body = '{"name":"Alice"}';
    const state = makeStateWithContext(memory, makeContext({ body }));
    const bridge = createRequestBridge(() => state);

    const ptr = bridge._req_body();
    expect(readLengthPrefixedString(memory, ptr)).toBe(body);
  });

  it('_req_json returns body when valid JSON, empty string for invalid', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const jsonBody = '{"key":"value"}';
    const state = makeStateWithContext(memory, makeContext({ body: jsonBody }));
    const bridge = createRequestBridge(() => state);

    const ptr = bridge._req_json();
    expect(readLengthPrefixedString(memory, ptr)).toBe(jsonBody);

    // Now test with invalid JSON
    state.requestContext!.body = 'not json at all';
    const ptr2 = bridge._req_json();
    expect(readLengthPrefixedString(memory, ptr2)).toBe('');
  });
});

describe('Request bridge — header, query, param, and cookie accessors', () => {
  it('_req_header returns the header value (case-insensitive lookup)', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      headers: { 'content-type': 'application/json', 'x-custom': 'abc' },
    }));
    const bridge = createRequestBridge(() => state);

    const nameLen = writeRawAt(memory, 64, 'content-type');
    const ptr = bridge._req_header(64, nameLen);
    expect(readLengthPrefixedString(memory, ptr)).toBe('application/json');
  });

  it('_req_header returns empty string for missing header', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({ headers: {} }));
    const bridge = createRequestBridge(() => state);

    const nameLen = writeRawAt(memory, 64, 'authorization');
    const ptr = bridge._req_header(64, nameLen);
    expect(readLengthPrefixedString(memory, ptr)).toBe('');
  });

  it('_req_query returns query parameter value and empty for missing param', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      query: { page: '2', limit: '10' },
    }));
    const bridge = createRequestBridge(() => state);

    const pageLen = writeRawAt(memory, 100, 'page');
    const ptr = bridge._req_query(100, pageLen);
    expect(readLengthPrefixedString(memory, ptr)).toBe('2');

    const missingLen = writeRawAt(memory, 200, 'sort');
    const ptr2 = bridge._req_query(200, missingLen);
    expect(readLengthPrefixedString(memory, ptr2)).toBe('');
  });

  it('_req_param returns route param value and _req_param_int parses integer', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      params: { id: '99', name: 'alice' },
    }));
    const bridge = createRequestBridge(() => state);

    const idLen = writeRawAt(memory, 64, 'id');
    const ptr = bridge._req_param(64, idLen);
    expect(readLengthPrefixedString(memory, ptr)).toBe('99');

    const intVal = bridge._req_param_int(64, idLen);
    expect(intVal).toBe(99);
  });

  it('_req_cookie returns cookie value and empty for missing cookie', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      cookies: { session_id: 'sess-abc' },
    }));
    const bridge = createRequestBridge(() => state);

    const keyLen = writeRawAt(memory, 64, 'session_id');
    const ptr = bridge._req_cookie(64, keyLen);
    expect(readLengthPrefixedString(memory, ptr)).toBe('sess-abc');

    const missingLen = writeRawAt(memory, 128, 'cart');
    const ptr2 = bridge._req_cookie(128, missingLen);
    expect(readLengthPrefixedString(memory, ptr2)).toBe('');
  });
});

describe('Request bridge — has_* presence checks', () => {
  it('_req_has_header returns 1 when present and 0 when absent', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      headers: { 'x-token': 'abc' },
    }));
    const bridge = createRequestBridge(() => state);

    const presentLen = writeRawAt(memory, 64, 'x-token');
    expect(bridge._req_has_header(64, presentLen)).toBe(1);

    const absentLen = writeRawAt(memory, 128, 'x-missing');
    expect(bridge._req_has_header(128, absentLen)).toBe(0);
  });

  it('_req_has_query returns 1/0 for query params', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      query: { debug: 'true' },
    }));
    const bridge = createRequestBridge(() => state);

    const pLen = writeRawAt(memory, 64, 'debug');
    expect(bridge._req_has_query(64, pLen)).toBe(1);

    const mLen = writeRawAt(memory, 128, 'verbose');
    expect(bridge._req_has_query(128, mLen)).toBe(0);
  });

  it('_req_has_cookie returns 1/0 for cookies', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      cookies: { token: 'xyz' },
    }));
    const bridge = createRequestBridge(() => state);

    const pLen = writeRawAt(memory, 64, 'token');
    expect(bridge._req_has_cookie(64, pLen)).toBe(1);

    const mLen = writeRawAt(memory, 128, 'other');
    expect(bridge._req_has_cookie(128, mLen)).toBe(0);
  });
});

describe('Request bridge — auth token and IP extraction', () => {
  it('_req_auth_token strips Bearer prefix', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      headers: { authorization: 'Bearer mytoken123' },
    }));
    const bridge = createRequestBridge(() => state);

    const ptr = bridge._req_auth_token();
    expect(readLengthPrefixedString(memory, ptr)).toBe('mytoken123');
  });

  it('_req_has_auth returns 1 with authorization header and 0 without', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const stateWith = makeStateWithContext(memory, makeContext({
      headers: { authorization: 'Bearer tok' },
    }));
    const bridgeWith = createRequestBridge(() => stateWith);
    expect(bridgeWith._req_has_auth()).toBe(1);

    const stateWithout = makeStateWithContext(memory, makeContext({ headers: {} }));
    const bridgeWithout = createRequestBridge(() => stateWithout);
    expect(bridgeWithout._req_has_auth()).toBe(0);
  });

  it('_req_ip reads X-Forwarded-For first, then X-Real-IP, then "unknown"', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });

    // X-Forwarded-For takes precedence
    const s1 = makeStateWithContext(memory, makeContext({
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    }));
    expect(readLengthPrefixedString(memory, createRequestBridge(() => s1)._req_ip())).toBe('1.2.3.4');

    // Falls back to X-Real-IP
    const s2 = makeStateWithContext(memory, makeContext({
      headers: { 'x-real-ip': '9.10.11.12' },
    }));
    expect(readLengthPrefixedString(memory, createRequestBridge(() => s2)._req_ip())).toBe('9.10.11.12');

    // Falls back to "unknown"
    const s3 = makeStateWithContext(memory, makeContext({ headers: {} }));
    expect(readLengthPrefixedString(memory, createRequestBridge(() => s3)._req_ip())).toBe('unknown');
  });
});

describe('Request bridge — form parsing and content type', () => {
  it('_req_form parses URL-encoded body into JSON object', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      body: 'name=Alice&age=30&active=true',
    }));
    const bridge = createRequestBridge(() => state);

    const ptr = bridge._req_form();
    const json = JSON.parse(readLengthPrefixedString(memory, ptr)) as Record<string, string>;
    expect(json.name).toBe('Alice');
    expect(json.age).toBe('30');
    expect(json.active).toBe('true');
  });

  it('_req_is_json returns 1 for application/json content-type', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeStateWithContext(memory, makeContext({
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }));
    const bridge = createRequestBridge(() => state);
    expect(bridge._req_is_json()).toBe(1);

    const state2 = makeStateWithContext(memory, makeContext({
      headers: { 'content-type': 'text/html' },
    }));
    const bridge2 = createRequestBridge(() => state2);
    expect(bridge2._req_is_json()).toBe(0);
  });
});
