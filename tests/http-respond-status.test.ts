/**
 * Bridge regression test for RUN001 / RUN002.
 *
 * Both reports claim that `_http_respond(non_200, ...)` is silently downgraded
 * to HTTP 200 by the node-server bridge when `_http_set_cache` (RUN001) or no
 * cache helper (RUN002) is called beforehand.
 *
 * If the bridge were the cause, the assertions below would fail. They do not:
 * the bridge writes the supplied status to `state.response.status` unconditionally,
 * regardless of any prior `_http_set_cache` / `_http_no_cache` call. This pins the
 * bridge contract so the test breaks loudly if a future change ever introduces
 * an "if first/already set" guard or commits status early.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHttpServerBridge } from '../src/bridge/http-server';
import type { WasmState, WasmResponse } from '../src/types';

function defaultResponse(): WasmResponse {
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: '', cookies: [] };
}

function makeMockState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];

  return {
    exports,
    response: defaultResponse(),
    config: { verbose: false },
  } as unknown as WasmState;
}

function writeRaw(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

describe('RUN001/RUN002 — _http_respond status is not downgraded', () => {
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createHttpServerBridge>;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 2 });
    state = makeMockState(memory, 4096);
    bridge = createHttpServerBridge(() => state);
  });

  it('set_cache(30) then respond(400, ...) yields status 400', () => {
    bridge._http_set_cache(30);

    const ctPtr = 64;
    const bodyPtr = 256;
    const ctLen = writeRaw(memory, ctPtr, 'application/json');
    const bodyLen = writeRaw(memory, bodyPtr, '{"error":"validation"}');

    bridge._http_respond(400, ctPtr, ctLen, bodyPtr, bodyLen);

    expect(state.response.status).toBe(400);
    expect(state.response.headers['Cache-Control']).toBe('public, max-age=30');
    expect(state.response.body).toBe('{"error":"validation"}');
  });

  it('no_cache() then respond(400, ...) yields status 400', () => {
    bridge._http_no_cache();

    const ctPtr = 64;
    const bodyPtr = 256;
    const ctLen = writeRaw(memory, ctPtr, 'application/json');
    const bodyLen = writeRaw(memory, bodyPtr, '{"error":"validation"}');

    bridge._http_respond(400, ctPtr, ctLen, bodyPtr, bodyLen);

    expect(state.response.status).toBe(400);
    expect(state.response.headers['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
    expect(state.response.body).toBe('{"error":"validation"}');
  });

  it('respond(400) then a SECOND respond(200) DOES downgrade to 200 — documents the framework auto-wrap bug', () => {
    // This is the actual root cause. The framework's frame.server expand_endpoints
    // auto-wraps `return helper_fn(...)` as `return jsonResponse(helper_fn(...))`
    // when the endpoint body does not directly contain a known response helper.
    // jsonResponse is _http_respond(200, "application/json", data) — so the second
    // call clobbers any status the inner helper set. This is a clean-framework bug,
    // not a clean-node-server bug.
    const ctPtr = 64;
    const bodyPtr = 256;
    const ctLen = writeRaw(memory, ctPtr, 'application/json');
    const bodyLen = writeRaw(memory, bodyPtr, '{"error":"validation"}');

    bridge._http_respond(400, ctPtr, ctLen, bodyPtr, bodyLen);
    expect(state.response.status).toBe(400);

    bridge._http_respond(200, ctPtr, ctLen, bodyPtr, bodyLen);
    expect(state.response.status).toBe(200);
  });
});
