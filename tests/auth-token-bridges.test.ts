/**
 * Bridge tests for FRAME-AUTH-REFRESH-TOKEN-NO-ROTATION and
 * FRAME-AUTH-RESET-TOKEN-BRIDGES-MISSING.
 *
 * Verifies _jwt_refresh_and_rotate enforces single-use rotation and that
 * _auth_create_reset_token / _auth_consume_reset_token round-trip correctly
 * with atomic consume semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { createAuthBridge, resetPasswordResetTokens } from '../src/bridge/auth';
import { createCryptoBridge, resetConsumedJtis } from '../src/bridge/crypto';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

const SECRET = 'test-secret';

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): { ptr: number; len: number } {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

function makeState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  const config = { jwtSecret: SECRET, verbose: false } as unknown as WasmState['config'];
  return { exports, config } as unknown as WasmState;
}

describe('_jwt_refresh_and_rotate', () => {
  let memory: WebAssembly.Memory;
  const HEAP_START = 4096;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 2 });
    resetConsumedJtis();
  });

  it('rotates a valid refresh token and rejects the replay', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createCryptoBridge(() => state);

    const token = jwt.sign(
      { sub: 'user-1', jti: 'jti-original', iat: Math.floor(Date.now() / 1000) },
      SECRET,
      { algorithm: 'HS256', expiresIn: 3600 }
    );

    const t1 = writeRawAt(memory, 8, token);
    const s1 = writeRawAt(memory, 8 + t1.len + 8, SECRET);
    const a1 = writeRawAt(memory, s1.ptr + s1.len + 8, 'HS256');

    const newPtr = bridge._jwt_refresh_and_rotate(
      t1.ptr, t1.len, s1.ptr, s1.len, a1.ptr, a1.len, 3600
    );
    const newToken = readLengthPrefixedString(memory, newPtr);
    expect(newToken).not.toBe('');
    expect(newToken).not.toBe(token);

    // New token verifies and carries a fresh jti + exp
    const decoded = jwt.verify(newToken, SECRET) as jwt.JwtPayload;
    expect(decoded.sub).toBe('user-1');
    expect(decoded.jti).not.toBe('jti-original');
    expect(typeof decoded.jti).toBe('string');

    // Replay of the original token must return empty
    const t2 = writeRawAt(memory, 2048, token);
    const s2 = writeRawAt(memory, 2048 + t2.len + 8, SECRET);
    const a2 = writeRawAt(memory, s2.ptr + s2.len + 8, 'HS256');
    const replayPtr = bridge._jwt_refresh_and_rotate(
      t2.ptr, t2.len, s2.ptr, s2.len, a2.ptr, a2.len, 3600
    );
    expect(readLengthPrefixedString(memory, replayPtr)).toBe('');
  });

  it('returns empty string for a token without jti', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createCryptoBridge(() => state);

    const token = jwt.sign({ sub: 'user-1' }, SECRET, { algorithm: 'HS256', expiresIn: 3600 });
    const t = writeRawAt(memory, 8, token);
    const s = writeRawAt(memory, t.ptr + t.len + 8, SECRET);
    const a = writeRawAt(memory, s.ptr + s.len + 8, 'HS256');
    const ptr = bridge._jwt_refresh_and_rotate(t.ptr, t.len, s.ptr, s.len, a.ptr, a.len, 3600);
    expect(readLengthPrefixedString(memory, ptr)).toBe('');
  });

  it('returns empty string when signature is invalid', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createCryptoBridge(() => state);

    const token = jwt.sign({ sub: 'user-1', jti: 'x' }, 'wrong-secret', { algorithm: 'HS256', expiresIn: 3600 });
    const t = writeRawAt(memory, 8, token);
    const s = writeRawAt(memory, t.ptr + t.len + 8, SECRET);
    const a = writeRawAt(memory, s.ptr + s.len + 8, 'HS256');
    const ptr = bridge._jwt_refresh_and_rotate(t.ptr, t.len, s.ptr, s.len, a.ptr, a.len, 3600);
    expect(readLengthPrefixedString(memory, ptr)).toBe('');
  });

  it('returns empty string when new_ttl_seconds is zero or negative', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createCryptoBridge(() => state);
    const token = jwt.sign({ sub: 'u', jti: 'j' }, SECRET, { algorithm: 'HS256', expiresIn: 3600 });
    const t = writeRawAt(memory, 8, token);
    const s = writeRawAt(memory, t.ptr + t.len + 8, SECRET);
    const a = writeRawAt(memory, s.ptr + s.len + 8, 'HS256');
    const ptr = bridge._jwt_refresh_and_rotate(t.ptr, t.len, s.ptr, s.len, a.ptr, a.len, 0);
    expect(readLengthPrefixedString(memory, ptr)).toBe('');
  });
});

describe('_auth_create_reset_token / _auth_consume_reset_token', () => {
  let memory: WebAssembly.Memory;
  const HEAP_START = 4096;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 2 });
    resetPasswordResetTokens();
  });

  it('round-trips: created token consumes back to the same userId', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createAuthBridge(() => state);

    const tokenPtr = bridge._auth_create_reset_token(42, 900);
    const token = readLengthPrefixedString(memory, tokenPtr);
    expect(token).not.toBe('');
    expect(token.length).toBe(64); // 32 bytes hex-encoded

    const raw = writeRawAt(memory, 8, token);
    const userId = bridge._auth_consume_reset_token(raw.ptr, raw.len);
    expect(userId).toBe(42);
  });

  it('cannot be consumed twice (atomic delete)', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createAuthBridge(() => state);

    const tokenPtr = bridge._auth_create_reset_token(7, 900);
    const token = readLengthPrefixedString(memory, tokenPtr);

    const raw1 = writeRawAt(memory, 8, token);
    expect(bridge._auth_consume_reset_token(raw1.ptr, raw1.len)).toBe(7);

    const raw2 = writeRawAt(memory, 2048, token);
    expect(bridge._auth_consume_reset_token(raw2.ptr, raw2.len)).toBe(0);
  });

  it('returns 0 for an unknown token', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createAuthBridge(() => state);
    const raw = writeRawAt(memory, 8, 'deadbeef'.repeat(8));
    expect(bridge._auth_consume_reset_token(raw.ptr, raw.len)).toBe(0);
  });

  it('returns 0 for an expired token', async () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createAuthBridge(() => state);

    // TTL of 0 is rejected; use a tiny positive TTL and wait past it.
    const tokenPtr = bridge._auth_create_reset_token(1, 1);
    const token = readLengthPrefixedString(memory, tokenPtr);
    expect(token).not.toBe('');

    // Fast-forward past TTL by mutating the store: simplest is to wait > 1s.
    await new Promise(r => setTimeout(r, 1100));

    const raw = writeRawAt(memory, 8, token);
    expect(bridge._auth_consume_reset_token(raw.ptr, raw.len)).toBe(0);
  });

  it('returns empty string for invalid create inputs', () => {
    const state = makeState(memory, HEAP_START);
    const bridge = createAuthBridge(() => state);
    expect(readLengthPrefixedString(memory, bridge._auth_create_reset_token(0, 900))).toBe('');
    expect(readLengthPrefixedString(memory, bridge._auth_create_reset_token(-1, 900))).toBe('');
    expect(readLengthPrefixedString(memory, bridge._auth_create_reset_token(1, 0))).toBe('');
    expect(readLengthPrefixedString(memory, bridge._auth_create_reset_token(1, -5))).toBe('');
  });
});
