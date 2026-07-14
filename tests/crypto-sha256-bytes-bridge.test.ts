/**
 * _crypto_sha256_bytes bridge — binary-safe SHA-256 over the same
 * length-prefixed byte handle produced by _req_body_bytes.
 *
 * Alignment: HOST_BRIDGE.md §Crypto, function-registry.toml entry
 * `_crypto_sha256_bytes`. Companion consumer to `_req_body_bytes` and
 * counterpart to `_crypto_hash_sha256` (which UTF-8 decodes its input and
 * therefore cannot be used on binary payloads).
 * Category: contract
 *
 * Covers the contract needed by the errors dashboard's tarball-upload
 * endpoint on the Node runtime:
 *   - Empty input yields the standard SHA-256 empty-string constant
 *   - Byte fidelity: null bytes, 0xFF, gzip magic all hash to the correct
 *     values (i.e. no UTF-8 detour is corrupting the bytes)
 *   - Output format: 64 lowercase hex characters, length-prefixed
 *   - Handle layout matches _req_body_bytes exactly, so the two compose
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createCryptoSha256BytesBridge } from '../src/bridge/crypto-sha256-bytes';
import {
  writeLengthPrefixedBytes,
  readLengthPrefixedString,
} from '../src/wasm/memory';
import type { WasmState } from '../src/types';

const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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

function readDigest(state: WasmState, ptr: number): string {
  return readLengthPrefixedString(state.exports.memory, ptr);
}

describe('_crypto_sha256_bytes — canonical vectors', () => {
  it('hashes the empty byte buffer to the well-known SHA-256 constant', () => {
    const state = makeMockState();
    const bridge = createCryptoSha256BytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array(0));
    const outPtr = bridge._crypto_sha256_bytes(bytesPtr);

    expect(readDigest(state, outPtr)).toBe(SHA256_EMPTY);
  });

  it('treats handle_ptr=0 as empty input (readLengthPrefixedBytes null-safety)', () => {
    const state = makeMockState();
    const bridge = createCryptoSha256BytesBridge(() => state);

    const outPtr = bridge._crypto_sha256_bytes(0);
    expect(readDigest(state, outPtr)).toBe(SHA256_EMPTY);
  });

  it('hashes "abc" to the FIPS 180-2 reference value', () => {
    const state = makeMockState();
    const bridge = createCryptoSha256BytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(
      state.exports,
      new TextEncoder().encode('abc'),
    );
    const outPtr = bridge._crypto_sha256_bytes(bytesPtr);
    expect(readDigest(state, outPtr)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('_crypto_sha256_bytes — byte fidelity', () => {
  it('hashes a payload containing null bytes without UTF-8 corruption', () => {
    const state = makeMockState();
    const bridge = createCryptoSha256BytesBridge(() => state);

    const payload = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xab, 0x00]);
    const bytesPtr = writeLengthPrefixedBytes(state.exports, payload);
    const outPtr = bridge._crypto_sha256_bytes(bytesPtr);

    const expected = createHash('sha256').update(payload).digest('hex');
    expect(readDigest(state, outPtr)).toBe(expected);
  });

  it('hashes high bytes (0xFF, invalid UTF-8) to the correct digest', () => {
    const state = makeMockState();
    const bridge = createCryptoSha256BytesBridge(() => state);

    const payload = new Uint8Array([0xff, 0xfe, 0xfd, 0xc0, 0xc1, 0x80]);
    const bytesPtr = writeLengthPrefixedBytes(state.exports, payload);
    const outPtr = bridge._crypto_sha256_bytes(bytesPtr);

    const expected = createHash('sha256').update(payload).digest('hex');
    expect(readDigest(state, outPtr)).toBe(expected);
  });

  it('hashes a synthetic gzip-like payload matching Node crypto', () => {
    const state = makeMockState();
    const bridge = createCryptoSha256BytesBridge(() => state);

    const gz = new Uint8Array(128);
    gz[0] = 0x1f;
    gz[1] = 0x8b;
    gz[2] = 0x08;
    for (let i = 3; i < gz.length; i++) gz[i] = (i * 53) & 0xff;
    const bytesPtr = writeLengthPrefixedBytes(state.exports, gz);
    const outPtr = bridge._crypto_sha256_bytes(bytesPtr);

    const expected = createHash('sha256').update(gz).digest('hex');
    expect(readDigest(state, outPtr)).toBe(expected);
  });
});

describe('_crypto_sha256_bytes — output format', () => {
  it('returns 64 lowercase hex characters', () => {
    const state = makeMockState();
    const bridge = createCryptoSha256BytesBridge(() => state);

    const bytesPtr = writeLengthPrefixedBytes(state.exports, new Uint8Array([0x42]));
    const outPtr = bridge._crypto_sha256_bytes(bytesPtr);

    const digest = readDigest(state, outPtr);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
