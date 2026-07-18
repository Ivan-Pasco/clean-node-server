/**
 * _req_body_sha256_hex bridge — server-computed SHA-256 over raw body
 *
 * Alignment: prompt 752c552c-7f3c-11f1-9d55-da25a95a496b
 *            (bridge gap for tarball-upload integrity check).
 * Category: contract
 *
 * Covers:
 *   - Hash is computed over ctx.bodyBytes verbatim (binary-safe: null
 *     bytes, invalid UTF-8, 0xFF all hash to the same digest that
 *     `openssl dgst -sha256` or Node's crypto.createHash would).
 *   - Return value is lowercase hex (64 characters) as an LP-string.
 *   - Fallback to UTF-8 encoding of ctx.body when bodyBytes is absent,
 *     matching the fallback behaviour of _req_body_bytes so a client
 *     that hashes the text-form body cross-checks the server-form hash.
 *   - Additive to _req_body / _req_body_bytes — invoking the hash does
 *     not consume or mutate the underlying context.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createRequestBridge } from '../src/bridge/request';
import { readLengthPrefixedString } from '../src/wasm/memory';
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
    path: '/api/v1/reports/tarball-upload',
    params: {},
    query: {},
    headers: {},
    body: '',
    cookies: {},
    ...overrides,
  };
}

function nodeSha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('_req_body_sha256_hex — binary payload hashing', () => {
  it('hashes raw bodyBytes (with null bytes and 0xFF) identically to Node crypto', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const binary = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x00, 0xab]);

    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: binary });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_sha256_hex();
    const hex = readLengthPrefixedString(memory, ptr);

    expect(hex).toBe(nodeSha256Hex(binary));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes a realistic tar.gz-shaped payload verbatim', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const gzMagic = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const rest = new Uint8Array(256);
    for (let i = 0; i < rest.length; i++) rest[i] = i & 0xff;
    const combined = new Uint8Array(gzMagic.length + rest.length);
    combined.set(gzMagic, 0);
    combined.set(rest, gzMagic.length);

    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: combined });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_sha256_hex();
    const hex = readLengthPrefixedString(memory, ptr);

    expect(hex).toBe(nodeSha256Hex(combined));
  });

  it('empty body hashes to the SHA-256 of an empty byte sequence', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: new Uint8Array(0) });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_sha256_hex();
    const hex = readLengthPrefixedString(memory, ptr);

    // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hex).toBe(nodeSha256Hex(new Uint8Array(0)));
  });
});

describe('_req_body_sha256_hex — text fallback path', () => {
  it('falls back to UTF-8 encoding of ctx.body when bodyBytes is absent', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const body = '{"hello":"world"}';
    const state = makeMockState(memory);
    state.requestContext = makeContext({ body });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_sha256_hex();
    const hex = readLengthPrefixedString(memory, ptr);

    expect(hex).toBe(nodeSha256Hex(new TextEncoder().encode(body)));
  });

  it('hashes multi-byte UTF-8 characters via the fallback path correctly', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const body = 'héllo 世界 🌍';
    const state = makeMockState(memory);
    state.requestContext = makeContext({ body });

    const bridge = createRequestBridge(() => state);
    const ptr = bridge._req_body_sha256_hex();
    const hex = readLengthPrefixedString(memory, ptr);

    expect(hex).toBe(nodeSha256Hex(new TextEncoder().encode(body)));
  });
});

describe('_req_body_sha256_hex — additive to existing surface', () => {
  it('does not mutate ctx.bodyBytes and can be called alongside _req_body_bytes', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const binary = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const state = makeMockState(memory);
    state.requestContext = makeContext({ bodyBytes: binary });

    const bridge = createRequestBridge(() => state);
    const hexBefore = readLengthPrefixedString(memory, bridge._req_body_sha256_hex());
    bridge._req_body_bytes();
    const hexAfter = readLengthPrefixedString(memory, bridge._req_body_sha256_hex());

    expect(hexBefore).toBe(hexAfter);
    expect(hexBefore).toBe(nodeSha256Hex(binary));
  });

  it('throws the same missing-context error _req_body_bytes does when context is unset', () => {
    const state = makeMockState();
    const bridge = createRequestBridge(() => state);
    expect(() => bridge._req_body_sha256_hex()).toThrow();
  });
});
