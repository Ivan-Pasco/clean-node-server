/**
 * frame.server WebSocket / LIVE-endpoint bridge — node-server stubs.
 *
 * Implemented in clean-server (Rust) at clean-server/src/websocket.rs:
 * connection registry, room broadcast, per-client send, message receive,
 * lifecycle dispatch. Backed by tokio-tungstenite.
 *
 * Porting to TypeScript (using the `ws` package) is tracked in
 * foundation/management/cross-component-prompts/
 *   all-host-bridge-parity-enforcement.md (Step 4 — node-server websocket).
 *
 * These stubs satisfy the linker so apps with LIVE endpoints instantiate on
 * node-server, but any actual ws operation throws with a clear message.
 *
 * Signature reference: foundation/platform-architecture/function-registry.toml
 * (entries with category = "websocket").
 */
import { WasmState } from '../types';

const NOT_IMPLEMENTED =
  'frame.server WebSocket runtime is not yet implemented on clean-node-server. ' +
  'See foundation/management/cross-component-prompts/' +
  'all-host-bridge-parity-enforcement.md for status.';

function notImplemented(fn: string): never {
  throw new Error(`${fn}: ${NOT_IMPLEMENTED}`);
}

export function createWebsocketBridge(_getState: () => WasmState) {
  return {
    _ws_send(_clientId: bigint, _msgPtr: number): void {
      notImplemented('_ws_send');
    },

    _ws_close(_clientId: bigint): void {
      notImplemented('_ws_close');
    },

    _ws_client_id(): bigint {
      notImplemented('_ws_client_id');
    },

    _ws_message(): number {
      notImplemented('_ws_message');
    },

    _ws_broadcast(_roomPtr: number, _msgPtr: number): void {
      notImplemented('_ws_broadcast');
    },

    _ws_room_join(_clientId: bigint, _roomPtr: number): void {
      notImplemented('_ws_room_join');
    },

    _ws_room_leave(_clientId: bigint, _roomPtr: number): void {
      notImplemented('_ws_room_leave');
    },

    _ws_room_broadcast(_roomPtr: number, _msgPtr: number): void {
      notImplemented('_ws_room_broadcast');
    },

    _http_ws_route(
      _pathPtr: number, _onConnectPtr: number, _onMessagePtr: number,
      _onClosePtr: number, _onErrorPtr: number,
    ): void {
      notImplemented('_http_ws_route');
    },
  };
}
