/**
 * NSR002 — string.concat must concatenate at the BYTE level.
 *
 * Root cause of the U+FFFD corruption on production cleanlanguage.dev
 * /tutorials: the compiler emits byte-position substring (i.e.
 * `s.substring(i, i + 1)` extracts exactly ONE byte at byte offset `i` from
 * the underlying UTF-8 buffer), so a `i = 0; while i < s.length(): i += 1`
 * iteration over a string containing multibyte UTF-8 yields a sequence of
 * length-prefixed fragments each holding a single continuation byte. The
 * fragments are then concatenated back together via the host's
 * `string.concat` bridge.
 *
 * If `string.concat` decodes each fragment as UTF-8 before joining (as the
 * pre-fix node-server bridge did), every continuation byte is invalid in
 * isolation and TextDecoder substitutes U+FFFD — turning a 3-byte em-dash
 * (E2 80 94) into three U+FFFD characters (EF BF BD × 3) and shifting the
 * byte count downstream, which truncated the /tutorials body at 12,799
 * bytes with 38 replacement characters. Rust clean-server's bridge does not
 * decode mid-concat (it operates on Vec<u8>), so the same WASM produced a
 * clean response there.
 *
 * Contract pinned below: feeding three single-byte fragments [E2], [80],
 * [94] through string.concat in sequence MUST reassemble the original
 * em-dash and decode (at a later boundary) to a single em-dash character.
 * Any future change that re-introduces a decode-then-join pattern breaks
 * here instead of silently producing U+FFFDs at runtime.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createStringBridge } from '../src/bridge/string';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState, WasmResponse } from '../src/types';

function defaultResponse(): WasmResponse {
  return { status: 200, headers: {}, body: '', cookies: [] };
}

function makeMockState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 8; // tiny gap so we never alias adjacent allocations
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return {
    exports,
    response: defaultResponse(),
    config: { verbose: false },
  } as unknown as WasmState;
}

/** Write a single-byte length-prefixed fragment containing `b`, return its ptr. */
function writeByteFragment(state: WasmState, b: number): number {
  const ptr = state.exports.malloc(5);
  const view = new DataView(state.exports.memory.buffer);
  view.setUint32(ptr, 1, true);
  new Uint8Array(state.exports.memory.buffer)[ptr + 4] = b;
  return ptr;
}

/** Write a multi-byte length-prefixed buffer with arbitrary content. */
function writeBytes(state: WasmState, bytes: number[]): number {
  const ptr = state.exports.malloc(4 + bytes.length);
  const view = new DataView(state.exports.memory.buffer);
  view.setUint32(ptr, bytes.length, true);
  new Uint8Array(state.exports.memory.buffer).set(bytes, ptr + 4);
  return ptr;
}

describe('NSR002 — string.concat byte-level contract', () => {
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createStringBridge>;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeMockState(memory, 4096);
    bridge = createStringBridge(() => state);
  });

  it('reassembles a 3-byte em-dash split across three single-byte fragments', () => {
    // The compiler-emitted byte-position substring of "—" (E2 80 94)
    // produces three single-byte fragments, fed back through concat.
    const b1 = writeByteFragment(state, 0xe2);
    const b2 = writeByteFragment(state, 0x80);
    const b3 = writeByteFragment(state, 0x94);

    // concat is left-associative in the compiler's emit: (b1 + b2) + b3
    const ab = bridge['string.concat'](b1, b2);
    const abc = bridge['string.concat'](ab, b3);

    const decoded = readLengthPrefixedString(memory, abc);
    expect(decoded).toBe('—');
    expect(decoded).not.toMatch(/�/);

    // Length prefix is the byte count, not the JS char count — pinning the
    // contract the rest of the bridge relies on.
    const view = new DataView(memory.buffer);
    expect(view.getUint32(abc, true)).toBe(3);
  });

  it('reassembles a 3-byte arrow (E2 86 92) the same way', () => {
    const fragments = [0xe2, 0x86, 0x92].map((b) => writeByteFragment(state, b));
    const result = fragments.reduce((acc, frag) => bridge['string.concat'](acc, frag));
    expect(readLengthPrefixedString(memory, result)).toBe('→');
  });

  it('reassembles a 4-byte emoji split across four single-byte fragments', () => {
    // U+1F980 🦀 = F0 9F A6 80 in UTF-8 — exercises the 4-byte path.
    const fragments = [0xf0, 0x9f, 0xa6, 0x80].map((b) => writeByteFragment(state, b));
    const result = fragments.reduce((acc, frag) => bridge['string.concat'](acc, frag));
    expect(readLengthPrefixedString(memory, result)).toBe('🦀');
  });

  it('concatenates a full ASCII prefix with a multibyte fragment then more ASCII', () => {
    // Exercises the realistic case from /tutorials head_html assembly:
    // "Tutorials " + "—" (one byte at a time) + " Learn".
    const prefix = writeBytes(state, Array.from('Tutorials ', (c) => c.charCodeAt(0)));
    const e2 = writeByteFragment(state, 0xe2);
    const x80 = writeByteFragment(state, 0x80);
    const x94 = writeByteFragment(state, 0x94);
    const suffix = writeBytes(state, Array.from(' Learn', (c) => c.charCodeAt(0)));

    let acc = bridge['string.concat'](prefix, e2);
    acc = bridge['string.concat'](acc, x80);
    acc = bridge['string.concat'](acc, x94);
    acc = bridge['string.concat'](acc, suffix);

    const decoded = readLengthPrefixedString(memory, acc);
    expect(decoded).toBe('Tutorials — Learn');
    expect(decoded).not.toMatch(/�/);
  });

  it('30-card render loop: byte-fragment em-dashes stay clean through repeated concat', () => {
    // Simulates the buildExamples / RenderTutorialsIndexSection loop that
    // emitted 30 tutorial cards. Each card title contains an em-dash, each
    // em-dash is byte-position-sliced into three single-byte fragments,
    // each fragment goes through string.concat — 30 iterations.
    let acc = writeBytes(state, []);
    for (let i = 0; i < 30; i++) {
      const card = writeBytes(state, Array.from(`Card ${i} `, (c) => c.charCodeAt(0)));
      const e2 = writeByteFragment(state, 0xe2);
      const x80 = writeByteFragment(state, 0x80);
      const x94 = writeByteFragment(state, 0x94);
      const trail = writeBytes(state, Array.from(' end\n', (c) => c.charCodeAt(0)));
      acc = bridge['string.concat'](acc, card);
      acc = bridge['string.concat'](acc, e2);
      acc = bridge['string.concat'](acc, x80);
      acc = bridge['string.concat'](acc, x94);
      acc = bridge['string.concat'](acc, trail);
    }

    const decoded = readLengthPrefixedString(memory, acc);
    expect(decoded).not.toMatch(/�/);
    // 30 em-dashes (3 bytes each → 1 JS char each).
    const emDashCount = (decoded.match(/—/g) ?? []).length;
    expect(emDashCount).toBe(30);
    // 30 lines.
    expect(decoded.split('\n').filter(Boolean).length).toBe(30);
  });

  it('empty + empty returns 0 (the empty-string ABI marker)', () => {
    const a = writeBytes(state, []);
    const b = writeBytes(state, []);
    expect(bridge['string.concat'](a, b)).toBe(0);
  });

  it('empty + non-empty returns a fresh buffer with the non-empty content', () => {
    // Ownership contract: concat returns a buffer the caller exclusively owns.
    // The previous "alias the non-empty input" optimization caused a deterministic
    // WASM trap on prod /tutorials (0.1.63 regression of NSR002 family) because the
    // compiler-emitted accumulator pattern would free or overwrite one input after
    // the call, leaving the returned alias pointing at dead memory.
    const empty = writeBytes(state, []);
    const non = writeBytes(state, [0x68, 0x69]);
    const r1 = bridge['string.concat'](empty, non);
    const r2 = bridge['string.concat'](non, empty);
    expect(r1).not.toBe(non);
    expect(r2).not.toBe(non);
    expect(readLengthPrefixedString(memory, r1)).toBe('hi');
    expect(readLengthPrefixedString(memory, r2)).toBe('hi');
  });

  it('zero pointer is treated as empty (compiler may pass 0 for the empty literal)', () => {
    const non = writeBytes(state, [0x68, 0x69]);
    const r1 = bridge['string.concat'](0, non);
    const r2 = bridge['string.concat'](non, 0);
    expect(r1).not.toBe(non);
    expect(r2).not.toBe(non);
    expect(readLengthPrefixedString(memory, r1)).toBe('hi');
    expect(readLengthPrefixedString(memory, r2)).toBe('hi');
    expect(bridge['string.concat'](0, 0)).toBe(0);
  });

  it('result does not alias either input — mutating an input buffer after concat must not change the result', () => {
    // Reproduces the production WASM trap mechanism: compiler-emitted accumulator
    // code reuses the input buffer after the concat call. If concat aliased one of
    // the inputs into the result, the subsequent reuse would corrupt the returned
    // buffer's length prefix and cause OOB reads on the next round of the loop.
    const a = writeBytes(state, [0x41, 0x42]); // "AB"
    const b = writeBytes(state, [0x43, 0x44]); // "CD"
    const r = bridge['string.concat'](a, b);

    expect(r).not.toBe(a);
    expect(r).not.toBe(b);

    // Clobber both input length prefixes — emulates the caller recycling them.
    const view = new DataView(memory.buffer);
    view.setUint32(a, 0xdeadbeef, true);
    view.setUint32(b, 0xdeadbeef, true);

    expect(readLengthPrefixedString(memory, r)).toBe('ABCD');
  });

  it('does not call TextDecoder on intermediate fragments', () => {
    // Regression pin: if a future change re-introduces decode-then-join,
    // the byte-position-substring of a 3-byte multibyte char would surface
    // as U+FFFD here.
    const eDash = [0xe2, 0x80, 0x94];
    let ptr = writeBytes(state, []);
    for (const b of eDash) {
      ptr = bridge['string.concat'](ptr, writeByteFragment(state, b));
    }
    const view = new DataView(memory.buffer);
    const len = view.getUint32(ptr, true);
    const bytes = new Uint8Array(memory.buffer, ptr + 4, len);
    expect(Array.from(bytes)).toEqual(eDash);
  });

  it('the snake_case alias string_concat has the same byte-level behavior', () => {
    const e2 = writeByteFragment(state, 0xe2);
    const x80 = writeByteFragment(state, 0x80);
    const x94 = writeByteFragment(state, 0x94);
    let acc = bridge.string_concat(e2, x80);
    acc = bridge.string_concat(acc, x94);
    expect(readLengthPrefixedString(memory, acc)).toBe('—');
  });
});
