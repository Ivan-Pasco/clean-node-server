/**
 * WebSocket bridge tests — route registration, send / broadcast / rooms,
 * current-context accessors. Real HTTP upgrades are out of scope here; the
 * tests use `_registerFakeConnectionForTest` to inject WebSocket-like fakes
 * so we can verify the bridge's mutations and dispatch logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createWebsocketBridge,
  _registerFakeConnectionForTest,
  _resetForTest,
  _setStateForTest,
  _withWsContextForTest,
  _getWsSnapshotForTest,
} from '../src/bridge/websocket';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

interface FakeSocket {
  send: (data: string) => void;
  close: () => void;
  sent: string[];
  closed: boolean;
}

function makeFakeSocket(): FakeSocket {
  const sent: string[] = [];
  return {
    send: (d) => sent.push(d),
    close: () => { fake.closed = true; },
    sent,
    closed: false,
    get [Symbol.toStringTag]() { return 'FakeSocket'; },
  } as unknown as FakeSocket;

  // (closure trickery: `fake` is bound at call site below)
}

// More robust factory — direct object so `close` can mutate `closed`.
function newFake(): FakeSocket {
  const obj: FakeSocket = {
    sent: [],
    closed: false,
    send: (d) => obj.sent.push(d),
    close: () => { obj.closed = true; },
  };
  return obj;
}

interface MockSetup {
  state: WasmState;
  fired: Array<{ name: string; clientId: bigint; message: string }>;
  writeString: (str: string) => { ptr: number; len: number };
  registerHandler: (name: string, fn: () => void) => void;
}

function makeMockState(): MockSetup {
  const memory = new WebAssembly.Memory({ initial: 4 });
  let writeCursor = 64;
  let heapPtr = 16384;
  const fired: MockSetup['fired'] = [];
  const exports: Record<string, unknown> = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  };
  const state = { exports, config: { verbose: false } } as unknown as WasmState;
  const writeString = (str: string): { ptr: number; len: number } => {
    const bytes = new TextEncoder().encode(str);
    new Uint8Array(memory.buffer).set(bytes, writeCursor);
    const out = { ptr: writeCursor, len: bytes.length };
    writeCursor += bytes.length + 16;
    return out;
  };
  const registerHandler = (name: string, fn: () => void): void => {
    exports[name] = fn;
  };
  return { state, fired, writeString, registerHandler };
}

function readLP(state: WasmState, ptr: number): string {
  return readLengthPrefixedString(state.exports.memory, ptr);
}

beforeEach(() => {
  _resetForTest();
});

describe('_http_ws_route', () => {
  it('records route handlers keyed by path', () => {
    const { state, writeString } = makeMockState();
    const bridge = createWebsocketBridge(() => state);

    const method = writeString('LIVE');
    const path = writeString('/live/chat');
    const onConn = writeString('on_chat_connect');
    const onMsg = writeString('on_chat_message');
    const onClose = writeString('on_chat_close');

    bridge._http_ws_route(
      method.ptr, method.len, path.ptr, path.len,
      onConn.ptr, onConn.len, onMsg.ptr, onMsg.len, onClose.ptr, onClose.len,
    );

    const snap = _getWsSnapshotForTest();
    expect(snap.routes).toHaveLength(1);
    expect(snap.routes[0]).toMatchObject({
      path: '/live/chat',
      onConnect: 'on_chat_connect',
      onMessage: 'on_chat_message',
      onClose: 'on_chat_close',
    });
  });
});

describe('_ws_send', () => {
  it('sends to a known client; silently ignores unknown ids', () => {
    const { state, writeString } = makeMockState();
    const bridge = createWebsocketBridge(() => state);

    const fake = newFake();
    const clientId = _registerFakeConnectionForTest(fake);

    const msg = writeString('hello');
    bridge._ws_send(clientId, msg.ptr, msg.len);
    expect(fake.sent).toEqual(['hello']);

    // Unknown id: no throw.
    const msg2 = writeString('ghost');
    expect(() =>
      bridge._ws_send(BigInt(99999), msg2.ptr, msg2.len),
    ).not.toThrow();
  });
});

describe('_ws_close', () => {
  it('closes the socket and evicts from registries', () => {
    const { state, writeString } = makeMockState();
    const bridge = createWebsocketBridge(() => state);

    const fake = newFake();
    const clientId = _registerFakeConnectionForTest(fake);

    // Drop into a room first so we can verify the room cleanup.
    const room = writeString('lobby');
    bridge._ws_room_join(clientId, room.ptr, room.len);
    expect(_getWsSnapshotForTest().rooms.lobby).toContain(String(clientId));

    bridge._ws_close(clientId);
    expect(fake.closed).toBe(true);
    expect(_getWsSnapshotForTest().connectionIds).not.toContain(String(clientId));
    expect(_getWsSnapshotForTest().rooms.lobby).toBeUndefined();
  });
});

describe('rooms', () => {
  it('join / leave / broadcast fan-out to room members only', () => {
    const { state, writeString } = makeMockState();
    const bridge = createWebsocketBridge(() => state);

    const a = newFake(); const b = newFake(); const c = newFake();
    const idA = _registerFakeConnectionForTest(a);
    const idB = _registerFakeConnectionForTest(b);
    const idC = _registerFakeConnectionForTest(c);

    const r1 = writeString('room1');
    bridge._ws_room_join(idA, r1.ptr, r1.len);
    const r2 = writeString('room1');
    bridge._ws_room_join(idB, r2.ptr, r2.len);
    // idC stays out of room1

    const broadcastRoom = writeString('room1');
    const broadcastMsg = writeString('hi');
    bridge._ws_broadcast(
      broadcastRoom.ptr, broadcastRoom.len,
      broadcastMsg.ptr, broadcastMsg.len,
    );

    expect(a.sent).toEqual(['hi']);
    expect(b.sent).toEqual(['hi']);
    expect(c.sent).toEqual([]);

    // Leave then re-broadcast.
    const leaveRoom = writeString('room1');
    bridge._ws_room_leave(idA, leaveRoom.ptr, leaveRoom.len);

    const broadcastRoom2 = writeString('room1');
    const broadcastMsg2 = writeString('again');
    bridge._ws_room_broadcast(
      broadcastRoom2.ptr, broadcastRoom2.len,
      broadcastMsg2.ptr, broadcastMsg2.len,
    );

    expect(a.sent).toEqual(['hi']);
    expect(b.sent).toEqual(['hi', 'again']);
  });

  it('broadcast to unknown room is a no-op', () => {
    const { state, writeString } = makeMockState();
    const bridge = createWebsocketBridge(() => state);

    const fake = newFake();
    _registerFakeConnectionForTest(fake);

    const room = writeString('ghosts');
    const msg = writeString('nope');
    bridge._ws_broadcast(room.ptr, room.len, msg.ptr, msg.len);
    expect(fake.sent).toEqual([]);
  });
});

describe('_ws_client_id / _ws_message context', () => {
  it('returns the current client id and message inside a ws context', () => {
    const { state } = makeMockState();
    const bridge = createWebsocketBridge(() => state);
    _setStateForTest(state);

    _withWsContextForTest(BigInt(42), 'incoming-payload', () => {
      expect(bridge._ws_client_id()).toBe(BigInt(42));
      const ptr = bridge._ws_message();
      expect(readLP(state, ptr)).toBe('incoming-payload');
    });
  });

  it('returns 0n / empty string outside a ws context', () => {
    const { state } = makeMockState();
    const bridge = createWebsocketBridge(() => state);
    _setStateForTest(state);

    expect(bridge._ws_client_id()).toBe(BigInt(0));
    expect(readLP(state, bridge._ws_message())).toBe('');
  });
});

describe('_ws_room_join is idempotent and ignores unknown clients', () => {
  it('does not throw when the clientId is unknown', () => {
    const { state, writeString } = makeMockState();
    const bridge = createWebsocketBridge(() => state);
    const r = writeString('any');
    expect(() => bridge._ws_room_join(BigInt(9999), r.ptr, r.len)).not.toThrow();
    expect(_getWsSnapshotForTest().rooms).toEqual({});
  });

  it('double-join is a no-op (Set semantics)', () => {
    const { state, writeString } = makeMockState();
    const bridge = createWebsocketBridge(() => state);
    const fake = newFake();
    const id = _registerFakeConnectionForTest(fake);
    const r1 = writeString('club');
    bridge._ws_room_join(id, r1.ptr, r1.len);
    const r2 = writeString('club');
    bridge._ws_room_join(id, r2.ptr, r2.len);

    const room = writeString('club');
    const msg = writeString('one');
    bridge._ws_broadcast(room.ptr, room.len, msg.ptr, msg.len);
    expect(fake.sent).toEqual(['one']); // not 2
  });
});
