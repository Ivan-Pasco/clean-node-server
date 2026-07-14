/**
 * _req_body_bytes bridge — raw request body byte access
 *
 * Alignment: MISSING-BRIDGE-REQ-BODY-BYTES on the errors dashboard.
 * Category: contract
 *
 * Covers the guarantees required to un-stub the errors dashboard's
 * POST /api/v1/reports/tarball-upload endpoint:
 *   - Binary payloads (0x00, 0xFF, invalid UTF-8 sequences) survive
 *     the round-trip through ctx.bodyBytes verbatim
 *   - Returned length equals the byte length of the source buffer
 *     (which handlers can compare against Content-Length)
 *   - Empty bodies return a zero-length buffer, not a null pointer
 *   - When ctx.bodyBytes is absent, _req_body_bytes falls back to
 *     encoding ctx.body as UTF-8 (backwards-compatible surface for
 *     content-types the raw parser didn't intercept)
 *   - _req_body is unchanged (additive contract)
 */

import { describe, it, expect } from 'vitest';
import { createRequestBridge } from '../src/bridge/request';
import { readLengthPrefixedBytes, readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState, RequestContext } from '../src/types';

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

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    method: 'POST',
    path: '/upload',
    params: {},
    query: {},
    headers: {},
    body: '',
    cookies: {},
    ...overrides,
  };
}

describe('_req_body_bytes — binary payload preservation', () => {
  it('returns raw bytes verbatim for a binary payload with null bytes and 0xFF', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const binary = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x00, 0xab]);

    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: binary });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_bytes();
    const out = readLengthPrefixedBytes(memory, ptr);

    expect(out.length).toBe(binary.length);
    expect(Array.from(out)).toEqual(Array.from(binary));
  });

  it('preserves a payload that is invalid UTF-8 (0xC0 0xC1 sequences)', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    // 0xC0 and 0xC1 are never valid UTF-8 lead bytes. Any UTF-8 decode step
    // between the wire and the bridge would replace them with U+FFFD and
    // change the byte count — SHA-256 over the result would no longer match.
    const invalidUtf8 = new Uint8Array([0xc0, 0xc1, 0xf5, 0xf6, 0xf7, 0xff]);

    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: invalidUtf8 });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_bytes();
    const out = readLengthPrefixedBytes(memory, ptr);

    expect(Array.from(out)).toEqual(Array.from(invalidUtf8));
  });

  it('preserves a realistic tar.gz-shaped payload (gzip magic + gzipped bytes)', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    // 0x1F 0x8B 0x08 = gzip magic + deflate method; the tarball-upload path
    // relies on these first three bytes being intact when the server hashes
    // the body to enforce the contract's integrity check.
    const gz = new Uint8Array(64);
    gz[0] = 0x1f;
    gz[1] = 0x8b;
    gz[2] = 0x08;
    for (let i = 3; i < gz.length; i++) gz[i] = (i * 37) & 0xff;

    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: gz });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_bytes();
    const out = readLengthPrefixedBytes(memory, ptr);

    expect(out.length).toBe(64);
    expect(out[0]).toBe(0x1f);
    expect(out[1]).toBe(0x8b);
    expect(out[2]).toBe(0x08);
    expect(Array.from(out)).toEqual(Array.from(gz));
  });
});

describe('_req_body_bytes — length semantics', () => {
  it('returns a zero-length buffer for an empty body (never a null pointer)', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: new Uint8Array(0) });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_bytes();

    // Pointer is non-null (allocation happened for the 4-byte header) and
    // the length prefix reads back as 0.
    expect(ptr).not.toBe(0);
    const out = readLengthPrefixedBytes(memory, ptr);
    expect(out.length).toBe(0);
  });

  it('length prefix matches source buffer length for a 4 KB payload', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: payload });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_bytes();
    const out = readLengthPrefixedBytes(memory, ptr);

    expect(out.length).toBe(4096);
    // Spot-check the interior — a UTF-8 detour would have expanded high bytes.
    expect(out[128]).toBe(128);
    expect(out[255]).toBe(255);
    expect(out[4095]).toBe(4095 & 0xff);
  });
});

describe('_req_body_bytes — fallback when ctx.bodyBytes is absent', () => {
  it('falls back to UTF-8 encoding of ctx.body when bodyBytes is undefined', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    state.requestContext = makeContext({ body: 'hello world' });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_bytes();
    const out = readLengthPrefixedBytes(memory, ptr);

    expect(new TextDecoder().decode(out)).toBe('hello world');
    expect(out.length).toBe(11);
  });

  it('fallback handles multi-byte UTF-8 characters correctly', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    // 'é' is 2 UTF-8 bytes (0xC3 0xA9); '文' is 3 bytes.
    state.requestContext = makeContext({ body: 'café文' });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_bytes();
    const out = readLengthPrefixedBytes(memory, ptr);

    expect(out.length).toBe(3 + 2 + 3);
    expect(new TextDecoder().decode(out)).toBe('café文');
  });
});

describe('_req_body_bytes — additive to _req_body (no regression)', () => {
  it('_req_body still returns the string surface when bodyBytes is populated', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    state.requestContext = makeContext({
      body: 'legacy-string-view',
      bodyBytes: new Uint8Array([0x00, 0xff]),
    });

    const bridge = createRequestBridge(() => state);
    const strPtr = bridge._req_body();
    expect(readLengthPrefixedString(memory, strPtr)).toBe('legacy-string-view');
  });

  it('throws the same missing-context error _req_body does when context is unset', () => {
    const state = makeMockState();
    const bridge = createRequestBridge(() => state);
    expect(() => bridge._req_body_bytes()).toThrow();
  });
});
