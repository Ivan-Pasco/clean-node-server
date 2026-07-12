/**
 * Session bridge tests — createSessionBridge
 *
 * Alignment: positive-path contract for session CRUD via the bridge glue.
 * Category: contract
 *
 * Tests cover:
 *   - _session_create returns a session ID LP-string and can be retrieved
 *   - _session_get returns JSON with userId/role/claims
 *   - _session_user_id and _session_role return correct subfields
 *   - _session_exists returns 1 when active, 0 without a session
 *   - _session_destroy invalidates the session (returns 1 on success, 0 when absent)
 *   - _session_store / _session_get_value / _session_delete / _session_has_key
 *   - _session_set_csrf / _session_get_csrf round-trip
 *   - All accessors return safe defaults (empty LP-string or 0) when no sessionId
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionBridge } from '../src/bridge/session';
import { InMemorySessionStore } from '../src/session/store';
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

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    method: 'GET',
    path: '/',
    params: {},
    query: {},
    headers: {},
    body: '',
    cookies: {},
    ...overrides,
  };
}

let sessionStore: InMemorySessionStore;

beforeEach(() => {
  sessionStore = new InMemorySessionStore(60_000);
});

afterEach(() => {
  sessionStore.close();
});

function makeFullState(memory: WebAssembly.Memory, ctx?: RequestContext, heapStart = 65_536): WasmState {
  const state = makeMockState(memory, heapStart);
  state.sessionStore = sessionStore;
  state.requestContext = ctx ?? makeContext();
  state.response = {
    status: 200,
    headers: {},
    body: '',
    cookies: [],
  };
  return state;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Session bridge — create and retrieve', () => {
  it('_session_create returns a non-empty LP-string session ID', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory);
    const bridge = createSessionBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const len = writeRawAt(memory, base, s);
      const r: [number, number] = [base, len];
      base += len + 16;
      return r;
    }

    const [up, ul] = a('user-1');
    const [rp, rl] = a('admin');
    const [cp, cl] = a('{}');

    const ptr = bridge._session_create(up, ul, rp, rl, cp, cl);
    const sessionId = readLengthPrefixedString(memory, ptr);
    expect(sessionId).toBeTruthy();
    expect(sessionId.length).toBeGreaterThan(8);
  });

  it('_session_get returns JSON with userId and role after _session_create', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory);
    const bridge = createSessionBridge(() => state);

    let base = 2048;
    function a(s: string): [number, number] {
      const len = writeRawAt(memory, base, s);
      const r: [number, number] = [base, len];
      base += len + 16;
      return r;
    }

    const [up, ul] = a('user-42');
    const [rp, rl] = a('editor');
    const [cp, cl] = a('{"perm":"write"}');

    // Create the session
    const idPtr = bridge._session_create(up, ul, rp, rl, cp, cl);
    const sessionId = readLengthPrefixedString(memory, idPtr);

    // Wire the session ID into the context so _session_get can find it
    state.requestContext!.sessionId = sessionId;

    const getPtr = bridge._session_get();
    const raw = readLengthPrefixedString(memory, getPtr);
    const data = JSON.parse(raw) as { userId: string; role: string; claims: Record<string, unknown> };

    expect(data.userId).toBe('user-42');
    expect(data.role).toBe('editor');
    expect(data.claims.perm).toBe('write');
  });
});

describe('Session bridge — user_id, role, exists, destroy', () => {
  it('_session_user_id and _session_role return correct subfields', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory);
    const bridge = createSessionBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const len = writeRawAt(memory, base, s);
      const r: [number, number] = [base, len];
      base += len + 16;
      return r;
    }

    const [up, ul] = a('alice');
    const [rp, rl] = a('superuser');
    const [cp, cl] = a('{}');

    const idPtr = bridge._session_create(up, ul, rp, rl, cp, cl);
    const sessionId = readLengthPrefixedString(memory, idPtr);
    state.requestContext!.sessionId = sessionId;

    expect(readLengthPrefixedString(memory, bridge._session_user_id())).toBe('alice');
    expect(readLengthPrefixedString(memory, bridge._session_role())).toBe('superuser');
  });

  it('_session_exists returns 1 for active session and 0 after destroy', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory);
    const bridge = createSessionBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const len = writeRawAt(memory, base, s);
      const r: [number, number] = [base, len];
      base += len + 16;
      return r;
    }

    const [up, ul] = a('bob');
    const [rp, rl] = a('user');
    const [cp, cl] = a('{}');

    const idPtr = bridge._session_create(up, ul, rp, rl, cp, cl);
    const sessionId = readLengthPrefixedString(memory, idPtr);
    state.requestContext!.sessionId = sessionId;

    expect(bridge._session_exists()).toBe(1);

    const destroyRc = bridge._session_destroy();
    expect(destroyRc).toBe(1);
    expect(bridge._session_exists()).toBe(0);
  });

  it('_session_exists and _session_destroy return 0 when no sessionId in context', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory, makeContext({ sessionId: undefined }));
    const bridge = createSessionBridge(() => state);

    expect(bridge._session_exists()).toBe(0);
    expect(bridge._session_destroy()).toBe(0);
  });
});

describe('Session bridge — store / get_value / delete / has_key', () => {
  it('_session_store + _session_get_value round-trip a string', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory);
    const bridge = createSessionBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const len = writeRawAt(memory, base, s);
      const r: [number, number] = [base, len];
      base += len + 16;
      return r;
    }

    const [up, ul] = a('charlie');
    const [rp, rl] = a('member');
    const [cp, cl] = a('{}');

    const idPtr = bridge._session_create(up, ul, rp, rl, cp, cl);
    state.requestContext!.sessionId = readLengthPrefixedString(memory, idPtr);

    const [kp, kl] = a('cart_id');
    const [vp, vl] = a('cart-xyz-123');

    const storeRc = bridge._session_store(kp, kl, vp, vl);
    expect(storeRc).toBe(1);

    const valPtr = bridge._session_get_value(kp, kl);
    expect(readLengthPrefixedString(memory, valPtr)).toBe('cart-xyz-123');
  });

  it('_session_has_key returns 1 after store, 0 after delete', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory);
    const bridge = createSessionBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const len = writeRawAt(memory, base, s);
      const r: [number, number] = [base, len];
      base += len + 16;
      return r;
    }

    const [up, ul] = a('dave');
    const [rp, rl] = a('user');
    const [cp, cl] = a('{}');

    const idPtr = bridge._session_create(up, ul, rp, rl, cp, cl);
    state.requestContext!.sessionId = readLengthPrefixedString(memory, idPtr);

    const [kp, kl] = a('token');
    const [vp, vl] = a('abc');

    bridge._session_store(kp, kl, vp, vl);
    expect(bridge._session_has_key(kp, kl)).toBe(1);

    bridge._session_delete(kp, kl);
    expect(bridge._session_has_key(kp, kl)).toBe(0);
  });
});

describe('Session bridge — CSRF token', () => {
  it('_session_set_csrf / _session_get_csrf round-trip correctly', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory);
    const bridge = createSessionBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const len = writeRawAt(memory, base, s);
      const r: [number, number] = [base, len];
      base += len + 16;
      return r;
    }

    const [up, ul] = a('eve');
    const [rp, rl] = a('user');
    const [cp, cl] = a('{}');

    const idPtr = bridge._session_create(up, ul, rp, rl, cp, cl);
    state.requestContext!.sessionId = readLengthPrefixedString(memory, idPtr);

    const csrfToken = 'csrf-token-7f3d9a';
    const [tp, tl] = a(csrfToken);

    expect(bridge._session_set_csrf(tp, tl)).toBe(1);

    const gotPtr = bridge._session_get_csrf();
    expect(readLengthPrefixedString(memory, gotPtr)).toBe(csrfToken);
  });

  it('_session_get_csrf returns empty string when no session', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeFullState(memory, makeContext({ sessionId: undefined }));
    const bridge = createSessionBridge(() => state);

    const ptr = bridge._session_get_csrf();
    expect(readLengthPrefixedString(memory, ptr)).toBe('');
  });
});
