import { parentPort } from 'worker_threads';
import { WasmState } from '../types';
import { readString } from './helpers';

/**
 * SSE bridge functions — full implementation for STREAM endpoint handlers.
 *
 * These functions are only meaningful when called from an SSE worker thread
 * (state.sseContext is set). In regular request workers and the init instance,
 * state.sseContext is undefined and all functions return immediately without
 * writing anything.
 *
 * Communication: the SSE worker calls parentPort.postMessage() to send events
 * to the main thread, which forwards them to the open Express response.
 *
 * Disconnect detection: the main thread writes 0 to sseContext.controlBuffer
 * when the client disconnects. _sse_is_connected reads it with Atomics.load so
 * the WASM handler can break out of its streaming loop without polling.
 */
export function createSseBridge(getState: () => WasmState) {
  return {
    /**
     * Write `data: {payload}\n\n` to the open SSE stream.
     * Returns 0 on success, -1 if no active SSE context.
     */
    _sse_emit(dataPtr: number, dataLen: number): number {
      const state = getState();
      if (!state.sseContext) return -1;
      const data = readString(state, dataPtr, dataLen);
      parentPort?.postMessage({ type: 'sse_emit', data });
      return 0;
    },

    /**
     * Write `event: {name}\ndata: {payload}\n\n` to the SSE stream.
     * Returns 0 on success, -1 if no active SSE context.
     */
    _sse_emit_event(
      namePtr: number,
      nameLen: number,
      dataPtr: number,
      dataLen: number
    ): number {
      const state = getState();
      if (!state.sseContext) return -1;
      const name = readString(state, namePtr, nameLen);
      const data = readString(state, dataPtr, dataLen);
      parentPort?.postMessage({ type: 'sse_emit_event', name, data });
      return 0;
    },

    /**
     * Flush and close the SSE response stream. Returns 0.
     */
    _sse_close(): number {
      const state = getState();
      if (!state.sseContext) return 0;
      parentPort?.postMessage({ type: 'sse_close' });
      return 0;
    },

    /**
     * Write `retry: {ms}\n\n` to the SSE stream to set the client
     * reconnect interval. Returns 0.
     */
    _sse_retry(ms: number): number {
      const state = getState();
      if (!state.sseContext) return 0;
      parentPort?.postMessage({ type: 'sse_retry', ms });
      return 0;
    },

    /**
     * Returns 1 if the SSE client connection is still open, 0 if disconnected.
     * Uses Atomics.load on the shared control buffer so the check is
     * thread-safe and does not require a round-trip to the main thread.
     */
    _sse_is_connected(): number {
      const state = getState();
      if (!state.sseContext) return 0;
      const control = new Int32Array(state.sseContext.controlBuffer);
      return Atomics.load(control, 0);
    },
  };
}
