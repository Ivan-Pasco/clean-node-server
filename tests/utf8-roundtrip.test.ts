/**
 * Multibyte UTF-8 round-trip contract — pins host bridge correctness.
 *
 * NSR002 claimed the host bridge corrupted multibyte UTF-8 (each em-dash byte
 * E2 80 94 surfacing as a U+FFFD replacement char in the HTTP response body).
 * Investigation showed the bridge actually preserves UTF-8 across the full
 * request flow when given valid input: writeLengthPrefixedString writes
 * `bytes.length` UTF-8 bytes; readLengthPrefixedString reads `bytes.length`
 * UTF-8 bytes; _json_get traverses and rewrites via the same helpers;
 * _http_respond does an explicit re-write back through writeString.
 *
 * If U+FFFD shows up in production traffic, WASM memory contains invalid
 * UTF-8 before the bridge reads it — the corruption is upstream (compiler
 * codegen or framework `http.respond` wrapper). These tests pin the bridge so
 * a future change that *introduces* a byte/char-count mismatch breaks loudly
 * here instead of silently producing replacement chars at runtime.
 *
 * Corpus mirrors what real users hit: em-dash (E2 80 94), arrow (E2 86 92),
 * en-dash (E2 80 93), smart quotes (E2 80 98–E2 80 9D), CJK (E4 B8 96),
 * accented Latin (C3 A9, C3 B1), euro (E2 82 AC), 4-byte emoji (F0 9F A6 80).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHttpServerBridge } from '../src/bridge/http-server';
import {
  readLengthPrefixedString,
  writeLengthPrefixedString,
} from '../src/wasm/memory';
import type { WasmState, WasmResponse } from '../src/types';

const MULTIBYTE_CORPUS = [
  'Tutorials — Learn Clean Language',
  'GET / → 200 Hello, World!',
  'Item — track →',
  '世界、こんにちは',
  'Café résumé piñata',
  '€ EUR / $ USD',
  'Smart "quotes" ‘single’',
  '🦀 Rust + 🟢 Node',
];

function defaultResponse(): WasmResponse {
  return { status: 200, headers: {}, body: '', cookies: [] };
}

function makeMockState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 8;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return {
    exports,
    response: defaultResponse(),
    config: { verbose: false },
  } as unknown as WasmState;
}

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

describe('UTF-8 round-trip contract — NSR002 regression pin', () => {
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createHttpServerBridge>;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 16 });
    state = makeMockState(memory, 131_072);
    bridge = createHttpServerBridge(() => state);
  });

  describe('writeLengthPrefixedString prefix is byte count, not char count', () => {
    it.each(MULTIBYTE_CORPUS)('writes UTF-8 byte length for %s', (str) => {
      const lp = writeLengthPrefixedString(state.exports as never, str);
      const view = new DataView(memory.buffer);
      const expected = new TextEncoder().encode(str).length;
      expect(view.getUint32(lp, true)).toBe(expected);
      expect(readLengthPrefixedString(memory, lp)).toBe(str);
    });
  });

  describe('_json_get preserves multibyte UTF-8 from any path depth', () => {
    it.each(MULTIBYTE_CORPUS)('round-trips %s through nested JSON', (str) => {
      const dbResult = { ok: true, data: { rows: [{ title: str }], count: 1 } };
      const jsonStr = JSON.stringify(dbResult);
      const jsonLp = writeLengthPrefixedString(state.exports as never, jsonStr);
      const jsonView = new DataView(memory.buffer);
      const jsonLen = jsonView.getUint32(jsonLp, true);
      const jsonPtr = jsonLp + 4;

      const path = 'data.rows.0.title';
      const pathPtr = 32;
      const pathLen = writeRawAt(memory, pathPtr, path);

      const titleLp = bridge._json_get(jsonPtr, jsonLen, pathPtr, pathLen);
      expect(readLengthPrefixedString(memory, titleLp)).toBe(str);
    });
  });

  describe('_http_respond preserves multibyte UTF-8 in body', () => {
    it.each(MULTIBYTE_CORPUS)('round-trips %s through respond → re-read', (str) => {
      const titleLp = writeLengthPrefixedString(state.exports as never, str);
      const view = new DataView(memory.buffer);
      const titleLen = view.getUint32(titleLp, true);
      const titlePtr = titleLp + 4;

      const ctPtr = 16;
      const ctLen = writeRawAt(memory, ctPtr, 'text/plain');

      const resultPtr = bridge._http_respond(200, ctPtr, ctLen, titlePtr, titleLen);

      // state.response.body — what the bridge set directly
      expect(state.response.body).toBe(str);
      expect(state.response.body).not.toMatch(/�/);

      // resultPtr — what request-worker.ts reads back to override the body
      expect(readLengthPrefixedString(memory, resultPtr)).toBe(str);
    });
  });

  it('full flow: writeString → _json_get → _http_respond preserves em-dash', () => {
    const dbResult = {
      ok: true,
      data: { rows: [{ title: 'Tutorials — Learn Clean Language' }], count: 1 },
    };
    const jsonLp = writeLengthPrefixedString(
      state.exports as never,
      JSON.stringify(dbResult),
    );
    const view = new DataView(memory.buffer);
    const jsonLen = view.getUint32(jsonLp, true);

    const pathPtr = 32;
    const pathLen = writeRawAt(memory, pathPtr, 'data.rows.0.title');

    const titleLp = bridge._json_get(jsonLp + 4, jsonLen, pathPtr, pathLen);
    const titleLen = view.getUint32(titleLp, true);

    const ctPtr = 16;
    const ctLen = writeRawAt(memory, ctPtr, 'text/plain');

    bridge._http_respond(200, ctPtr, ctLen, titleLp + 4, titleLen);

    expect(state.response.body).toBe('Tutorials — Learn Clean Language');
    expect(state.response.body).not.toMatch(/�/);
  });

  it('30-row loop with multibyte titles terminates and preserves every value', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      title: `Item ${i} — track →`,
    }));
    const dbResult = { ok: true, data: { rows, count: rows.length } };
    const jsonLp = writeLengthPrefixedString(
      state.exports as never,
      JSON.stringify(dbResult),
    );
    const view = new DataView(memory.buffer);
    const jsonLen = view.getUint32(jsonLp, true);

    const decoded: string[] = [];
    for (let i = 0; i < 30; i++) {
      const pathPtr = 32;
      const pathLen = writeRawAt(memory, pathPtr, `data.rows.${i}.title`);
      const lp = bridge._json_get(jsonLp + 4, jsonLen, pathPtr, pathLen);
      decoded.push(readLengthPrefixedString(memory, lp));
    }

    for (let i = 0; i < 30; i++) {
      expect(decoded[i]).toBe(`Item ${i} — track →`);
      expect(decoded[i]).not.toMatch(/�/);
    }

    // Out-of-bounds index must return empty, which is the loop termination signal.
    const pathPtr = 32;
    const pathLen = writeRawAt(memory, pathPtr, 'data.rows.30.title');
    const sentinelLp = bridge._json_get(jsonLp + 4, jsonLen, pathPtr, pathLen);
    expect(readLengthPrefixedString(memory, sentinelLp)).toBe('');
  });
});
