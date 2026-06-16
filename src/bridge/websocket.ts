/**
 * frame.server WebSocket / LIVE-endpoint bridge — node-server implementation.
 *
 * Mirrors clean-server/src/websocket.rs:
 *   - Per-path route registry storing the three WASM export names registered
 *     via `_http_ws_route` (onConnect / onMessage / onClose).
 *   - Connection registry keyed by client id (monotonically assigned bigint).
 *   - Room membership registry for broadcast fan-out.
 *   - AsyncLocalStorage for the current-call context so `_ws_client_id` and
 *     `_ws_message` resolve from inside handler dispatch.
 *
 * The HTTP-upgrade wiring is initialised by `attachWebsocketServer(httpServer,
 * state)` which the main process calls once `httpServer.listen()` is bound.
 * That hooks `server.on('upgrade')` to forward upgrades on registered WS
 * paths into the `ws` package. The bridge itself stays pure — it only mutates
 * the in-memory registries — so unit tests can exercise it without standing
 * up an HTTP listener (the tests inject fake WebSocket-like objects).
 *
 * Signature reference: foundation/platform-architecture/function-registry.toml
 * (entries with category = "websocket"). WASM-level ABI matches
 * clean-server/src/bridge.rs `register_websocket_functions`.
 *
 * Client-id width note: clean-server uses `i32` in its `func_wrap`; the
 * registry header maps "integer" to `i64`. node-server's existing linker
 * contract uses bigint (i64), matching the registry. Conversions are explicit
 * at the boundary so behaviour is predictable.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type * as http from 'node:http';
import type { WebSocketServer, WebSocket as WsClient } from 'ws';
import { WasmState } from '../types';
import { readString, writeString } from './helpers';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface WsRoute {
  path: string;
  onConnect: string;
  onMessage: string;
  onClose: string;
}

interface WsConnection {
  clientId: bigint;
  socket: WsClient;
  rooms: Set<string>;
}

const wsRoutes = new Map<string, WsRoute>();
const connections = new Map<bigint, WsConnection>();
const rooms = new Map<string, Set<bigint>>();

let wsState: WasmState | null = null;
let wsServer: WebSocketServer | null = null;
let httpServerRef: http.Server | null = null;
let upgradeHandler: ((req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => void) | null = null;
let clientIdCounter = 0n;

interface WsLocalContext {
  clientId: bigint;
  message: string;
}

const wsLocal = new AsyncLocalStorage<WsLocalContext>();

function verboseLog(msg: string): void {
  if (wsState?.config?.verbose) {
    // eslint-disable-next-line no-console
    console.log(`[ws] ${msg}`);
  }
}

function warnLog(msg: string, err?: unknown): void {
  const detail = err === undefined
    ? ''
    : `: ${err instanceof Error ? err.message : String(err)}`;
  // eslint-disable-next-line no-console
  console.error(`[ws] ${msg}${detail}`);
}

// ---------------------------------------------------------------------------
// Handler dispatch
// ---------------------------------------------------------------------------

function callWasmHandler(handlerName: string, clientId: bigint, message: string): void {
  const state = wsState;
  if (!state || !handlerName) return;
  const handler = state.exports[handlerName];
  if (typeof handler !== 'function') {
    warnLog(`handler '${handlerName}' not found in WASM exports`);
    return;
  }
  wsLocal.run({ clientId, message }, () => {
    try {
      (handler as () => unknown)();
    } catch (err) {
      warnLog(`handler '${handlerName}' threw for client ${clientId}`, err);
    }
  });
}

// ---------------------------------------------------------------------------
// Public lifecycle
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocket upgrade handler to the given http.Server. Idempotent
 * within a single process. Must be called after registered routes have
 * been seen (i.e. after the init WASM `start()` runs) but before the server
 * accepts connections — `server.ts` does this in `start()`.
 */
export async function attachWebsocketServer(
  httpServer: http.Server,
  state: WasmState,
): Promise<void> {
  if (wsServer) return;
  wsState = state;
  httpServerRef = httpServer;

  const { WebSocketServer: ServerCtor } = await import('ws');
  wsServer = new ServerCtor({ noServer: true });

  upgradeHandler = (req, socket, head) => {
    const url = req.url ?? '/';
    const route = wsRoutes.get(url);
    if (!route) {
      socket.destroy();
      return;
    }
    wsServer!.handleUpgrade(req, socket, head, (ws) => {
      const clientId = ++clientIdCounter;
      const conn: WsConnection = { clientId, socket: ws, rooms: new Set() };
      connections.set(clientId, conn);
      verboseLog(`${url}: client ${clientId} connected`);
      callWasmHandler(route.onConnect, clientId, '');

      ws.on('message', (data) => {
        const message = data.toString();
        callWasmHandler(route.onMessage, clientId, message);
      });

      ws.on('close', () => {
        callWasmHandler(route.onClose, clientId, '');
        connections.delete(clientId);
        for (const members of rooms.values()) members.delete(clientId);
        verboseLog(`${url}: client ${clientId} disconnected`);
      });

      ws.on('error', (err) => {
        warnLog(`${url}: client ${clientId} error`, err);
      });
    });
  };

  httpServer.on('upgrade', upgradeHandler);
}

/** Detach the upgrade handler and close every connection. Idempotent. */
export function stopWebsocketServer(): void {
  if (httpServerRef && upgradeHandler) {
    httpServerRef.off('upgrade', upgradeHandler);
  }
  for (const conn of connections.values()) {
    try { conn.socket.close(); } catch { /* ignore */ }
  }
  if (wsServer) {
    try { wsServer.close(); } catch { /* ignore */ }
  }
  connections.clear();
  rooms.clear();
  wsRoutes.clear();
  clientIdCounter = 0n;
  wsServer = null;
  wsState = null;
  httpServerRef = null;
  upgradeHandler = null;
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Test-only: register a fake WebSocket-like connection so the bridge
 * mutators (`_ws_send`, `_ws_broadcast`, room membership) can be exercised
 * without standing up an HTTP listener. The fake only needs `send(data)` and
 * `close()`. Returns the synthesised clientId.
 */
export function _registerFakeConnectionForTest(
  socket: { send: (data: string) => void; close: () => void },
): bigint {
  const clientId = ++clientIdCounter;
  connections.set(clientId, {
    clientId,
    socket: socket as unknown as WsClient,
    rooms: new Set(),
  });
  return clientId;
}

/** Test-only: drop everything (registries, ids) without touching httpServer state. */
export function _resetForTest(): void {
  connections.clear();
  rooms.clear();
  wsRoutes.clear();
  clientIdCounter = 0n;
  wsState = null;
}

/** Test-only: set the WASM state used for handler dispatch. */
export function _setStateForTest(state: WasmState): void {
  wsState = state;
}

/** Test-only: run a function inside a fake ws context (for `_ws_client_id` / `_ws_message`). */
export function _withWsContextForTest<T>(clientId: bigint, message: string, fn: () => T): T {
  return wsLocal.run({ clientId, message }, fn);
}

/** Test-only: route + connection snapshot. */
export function _getWsSnapshotForTest(): {
  routes: WsRoute[];
  connectionIds: string[];
  rooms: Record<string, string[]>;
} {
  return {
    routes: [...wsRoutes.values()].map(r => ({ ...r })),
    connectionIds: [...connections.keys()].map(String),
    rooms: Object.fromEntries(
      [...rooms.entries()].map(([k, v]) => [k, [...v].map(String)]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Bridge functions
// ---------------------------------------------------------------------------

export function createWebsocketBridge(getState: () => WasmState) {
  return {
    /**
     * Register a WebSocket route. Registry: 5 strings (method, path,
     * onConnect, onMessage, onClose), returns void. WASM ABI: 10 i32
     * (5 ptr+len pairs). `method` is conventionally "LIVE" but is accepted
     * for symmetry with `_http_route` and otherwise ignored.
     */
    _http_ws_route(
      _methodPtr: number, _methodLen: number,
      pathPtr: number, pathLen: number,
      onConnectPtr: number, onConnectLen: number,
      onMessagePtr: number, onMessageLen: number,
      onClosePtr: number, onCloseLen: number,
    ): void {
      const state = getState();
      const path = readString(state, pathPtr, pathLen);
      const onConnect = readString(state, onConnectPtr, onConnectLen);
      const onMessage = readString(state, onMessagePtr, onMessageLen);
      const onClose = readString(state, onClosePtr, onCloseLen);
      wsRoutes.set(path, { path, onConnect, onMessage, onClose });
      // Capture the state for handler dispatch — the init instance sets it
      // here so even tests that don't call attachWebsocketServer get firing.
      if (!wsState) wsState = state;
      verboseLog(`route: ${path} -> onConnect=${onConnect}, onMessage=${onMessage}, onClose=${onClose}`);
    },

    /**
     * Send a text message to a specific client. Registry: (integer, string)
     * — i64 client id, then ptr+len. No-op if the client is unknown.
     */
    _ws_send(clientId: bigint, msgPtr: number, msgLen: number): void {
      const state = getState();
      const conn = connections.get(clientId);
      if (!conn) return;
      const msg = msgLen > 0 ? readString(state, msgPtr, msgLen) : '';
      try {
        conn.socket.send(msg);
      } catch (err) {
        warnLog(`send to client ${clientId} failed`, err);
      }
    },

    /**
     * Broadcast a message to every client in a room.
     * Registry: (string, string). Identical in behaviour to
     * `_ws_room_broadcast` — both are kept because the framework emits both
     * names from different code paths.
     */
    _ws_broadcast(roomPtr: number, roomLen: number, msgPtr: number, msgLen: number): void {
      const state = getState();
      const room = readString(state, roomPtr, roomLen);
      const msg = msgLen > 0 ? readString(state, msgPtr, msgLen) : '';
      broadcastToRoom(room, msg);
    },

    /** Identical to `_ws_broadcast`. Registry: (string, string). */
    _ws_room_broadcast(roomPtr: number, roomLen: number, msgPtr: number, msgLen: number): void {
      const state = getState();
      const room = readString(state, roomPtr, roomLen);
      const msg = msgLen > 0 ? readString(state, msgPtr, msgLen) : '';
      broadcastToRoom(room, msg);
    },

    /** Close a client's connection. Registry: (integer). */
    _ws_close(clientId: bigint): void {
      const conn = connections.get(clientId);
      if (!conn) return;
      try { conn.socket.close(); } catch (err) { warnLog(`close ${clientId} failed`, err); }
      // The 'close' listener registered in attachWebsocketServer handles
      // registry eviction; for fake test connections without a 'close' event
      // we evict here so tests observe deletion deterministically.
      connections.delete(clientId);
      for (const [room, members] of rooms) {
        members.delete(clientId);
        if (members.size === 0) rooms.delete(room);
      }
    },

    /** Current client id inside a handler. 0n outside. */
    _ws_client_id(): bigint {
      return wsLocal.getStore()?.clientId ?? 0n;
    },

    /** Current incoming message (LP). Empty string outside an onMessage handler. */
    _ws_message(): number {
      const state = getState();
      const msg = wsLocal.getStore()?.message ?? '';
      return writeString(state, msg);
    },

    /** Add a client to a named room. */
    _ws_room_join(clientId: bigint, roomPtr: number, roomLen: number): void {
      const state = getState();
      if (!connections.has(clientId)) return;
      const room = readString(state, roomPtr, roomLen);
      if (!room) return;
      const members = rooms.get(room) ?? new Set<bigint>();
      members.add(clientId);
      rooms.set(room, members);
      connections.get(clientId)?.rooms.add(room);
    },

    /** Remove a client from a named room. */
    _ws_room_leave(clientId: bigint, roomPtr: number, roomLen: number): void {
      const state = getState();
      const room = readString(state, roomPtr, roomLen);
      const members = rooms.get(room);
      if (!members) return;
      members.delete(clientId);
      if (members.size === 0) rooms.delete(room);
      connections.get(clientId)?.rooms.delete(room);
    },
  };
}

function broadcastToRoom(room: string, msg: string): void {
  const members = rooms.get(room);
  if (!members) return;
  for (const clientId of members) {
    const conn = connections.get(clientId);
    if (!conn) continue;
    try {
      conn.socket.send(msg);
    } catch (err) {
      warnLog(`broadcast to client ${clientId} in room '${room}' failed`, err);
    }
  }
}
