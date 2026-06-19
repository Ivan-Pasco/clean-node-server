/**
 * WASM ABI Contract Tests — String Bridge Calling Conventions
 *
 * The Clean Language compiler generates WASM using two distinct calling
 * conventions for string arguments passed to host bridge functions:
 *
 * 1. LP-POINTER CONVENTION — string.concat, string_compare, string_replace, string_split
 *    WASM passes one i32 per string argument. That i32 points to a
 *    length-prefixed allocation: memory[ptr..ptr+4] = LE length,
 *    memory[ptr+4..ptr+4+len] = UTF-8 content.
 *    No compiler-generated wrapper unpacks these before the host call.
 *
 * 2. RAW PTR+LEN CONVENTION — all other bridge functions
 *    The compiler generates WASM wrapper functions that unpack LP strings
 *    into (content_ptr, len) pairs. The host receives two i32s per string.
 *
 * Getting convention 1 wrong (treating LP-pointers as ptr+len pairs) causes
 * the host to misread a large pointer address as a string length, triggering
 * exponential memory growth and "offset is out of bounds" crashes on any
 * route that concatenates strings before a DB call.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createStringBridge } from '../src/bridge/string';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Write a length-prefixed string at a fixed address in WASM memory. */
function writeLPAt(memory: WebAssembly.Memory, ptr: number, str: string): void {
  const bytes = new TextEncoder().encode(str);
  const view = new DataView(memory.buffer);
  view.setUint32(ptr, bytes.length, true); // little-endian length prefix
  new Uint8Array(memory.buffer).set(bytes, ptr + 4);
}

/**
 * Build a minimal mock WasmState with a bump allocator starting at heapStart.
 * Pre-written LP strings must live at addresses below heapStart.
 */
function makeMockState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4; // +4 alignment pad
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return { exports } as unknown as WasmState;
}

// ─── LP-Pointer Convention Tests ─────────────────────────────────────────────

describe('String Bridge ABI — LP-pointer convention', () => {
  let memory: WebAssembly.Memory;

  // Fixed addresses for pre-written LP strings (all below HEAP_START)
  const ADDR_HELLO = 64;   // "Hello, "
  const ADDR_WORLD = 128;  // "World!"
  const ADDR_FOO   = 256;  // "foo-bar-baz"
  const ADDR_DASH  = 320;  // "-"
  const ADDR_A     = 384;  // "apple"
  const ADDR_B     = 448;  // "apple"  (same content, for equality check)
  const ADDR_C     = 512;  // "orange"
  const ADDR_SUBJ  = 576;  // "hello world hello"
  const ADDR_PAT   = 640;  // "hello"
  const ADDR_REP   = 704;  // "hi"
  const HEAP_START = 2048;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 2 }); // 128 KB
    writeLPAt(memory, ADDR_HELLO, 'Hello, ');
    writeLPAt(memory, ADDR_WORLD, 'World!');
    writeLPAt(memory, ADDR_FOO,   'foo-bar-baz');
    writeLPAt(memory, ADDR_DASH,  '-');
    writeLPAt(memory, ADDR_A,     'apple');
    writeLPAt(memory, ADDR_B,     'apple');
    writeLPAt(memory, ADDR_C,     'orange');
    writeLPAt(memory, ADDR_SUBJ,  'hello world hello');
    writeLPAt(memory, ADDR_PAT,   'hello');
    writeLPAt(memory, ADDR_REP,   'hi');
  });

  describe('string.concat', () => {
    it('concatenates two strings via LP-pointer args', () => {
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      // ABI: bridge receives (lp_ptr_a, lp_ptr_b) — each i32 points to an LP string
      const resultPtr = bridge.string_concat(ADDR_HELLO, ADDR_WORLD);

      expect(resultPtr).toBeGreaterThan(0);
      expect(readLengthPrefixedString(memory, resultPtr)).toBe('Hello, World!');
    });

    it('does not throw when called with LP-pointer addresses', () => {
      // If convention were wrong, ADDR_WORLD (128) would be treated as a
      // string length, causing reads of 128+ bytes from an 8-byte string.
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      expect(() => bridge.string_concat(ADDR_HELLO, ADDR_WORLD)).not.toThrow();
    });

    it('handles empty string operand', () => {
      const emptyAddr = 800;
      writeLPAt(memory, emptyAddr, '');
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      expect(readLengthPrefixedString(memory, bridge.string_concat(ADDR_HELLO, emptyAddr)))
        .toBe('Hello, ');
    });
  });

  describe('string_compare', () => {
    // Fixed: was 1 for equal / 0 for different (wrong). Spec requires 0=equal,
    // non-zero=different because compiler codegen emits i32.eqz after this call.
    it('returns 0 for equal strings', () => {
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      expect(bridge.string_compare(ADDR_A, ADDR_B)).toBe(0);
    });

    it('returns 1 for different strings', () => {
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      expect(bridge.string_compare(ADDR_A, ADDR_C)).toBe(1);
    });

    it('does not throw when called with LP-pointer addresses', () => {
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      expect(() => bridge.string_compare(ADDR_A, ADDR_B)).not.toThrow();
    });
  });

  describe('string_replace', () => {
    it('replaces all occurrences via 3 LP-pointer args', () => {
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      const resultPtr = bridge.string_replace(ADDR_SUBJ, ADDR_PAT, ADDR_REP);
      expect(readLengthPrefixedString(memory, resultPtr)).toBe('hi world hi');
    });

    it('returns original string when pattern not found', () => {
      const notFoundAddr = 900;
      writeLPAt(memory, notFoundAddr, 'xyz');
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      const resultPtr = bridge.string_replace(ADDR_SUBJ, notFoundAddr, ADDR_REP);
      expect(readLengthPrefixedString(memory, resultPtr)).toBe('hello world hello');
    });
  });

  describe('string_split', () => {
    // CONTRACT: string_split returns a Clean Language list<string> pointer, NOT
    // a JSON-encoded LP string. Layout: [length@0, capacity@4, type_id@8,
    // padding@12, ptr@16+i*4]. Each element pointer addresses a length-prefixed
    // string. The compiler's `iterate part in parts` reads this layout
    // directly. Pre-fix this function returned LP-JSON and `iterate` traps —
    // HOST_BRIDGE_STRING_SPLIT_RETURNS_JSON_STRING_NOT_LIST.

    /** Decode a Clean list<string> from WASM memory at listPtr. */
    function readStringList(mem: WebAssembly.Memory, listPtr: number): string[] {
      const view = new DataView(mem.buffer);
      const length = view.getUint32(listPtr, true);
      const out: string[] = [];
      for (let i = 0; i < length; i++) {
        const elemPtr = view.getUint32(listPtr + 16 + i * 4, true);
        out.push(readLengthPrefixedString(mem, elemPtr));
      }
      return out;
    }

    it('returns a list-layout pointer with the split parts, via LP-pointer args', () => {
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      const resultPtr = bridge.string_split(ADDR_FOO, ADDR_DASH);
      expect(readStringList(memory, resultPtr)).toEqual(['foo', 'bar', 'baz']);
    });

    it('returns single-element list when delimiter absent', () => {
      const pipeAddr = 960;
      writeLPAt(memory, pipeAddr, '|');
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      const resultPtr = bridge.string_split(ADDR_FOO, pipeAddr);
      expect(readStringList(memory, resultPtr)).toEqual(['foo-bar-baz']);
    });

    it('list header matches the layout the compiler `iterate` reads (length@0, capacity@4, type_id@8)', () => {
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      const resultPtr = bridge.string_split(ADDR_FOO, ADDR_DASH);
      const view = new DataView(memory.buffer);
      expect(view.getUint32(resultPtr + 0, true)).toBe(3);  // length
      expect(view.getUint32(resultPtr + 4, true)).toBe(3);  // capacity
      expect(view.getUint32(resultPtr + 8, true)).toBe(3);  // type_id (3 = string)
      expect(view.getUint32(resultPtr + 12, true)).toBe(0); // padding
    });

    it('regression: iterate-style read counts and decodes 4 parts for "a```b```c```d" split on "```"', () => {
      // This is the exact failure mode from
      // HOST_BRIDGE_STRING_SPLIT_RETURNS_JSON_STRING_NOT_LIST: when the bridge
      // returned LP-JSON, an iterate over a 4-element split walked 17 times
      // (the JSON byte length) and trapped. The list layout below must keep
      // size@0 == 4 so iterate runs exactly 4 times.
      const srcAddr = 1024;
      const sepAddr = 1152;
      writeLPAt(memory, srcAddr, 'a```b```c```d');
      writeLPAt(memory, sepAddr, '```');
      const state = makeMockState(memory, HEAP_START);
      const bridge = createStringBridge(() => state);

      const resultPtr = bridge.string_split(srcAddr, sepAddr);
      const view = new DataView(memory.buffer);
      const sizeAt0 = view.getUint32(resultPtr, true);
      expect(sizeAt0).toBe(4);
      expect(readStringList(memory, resultPtr)).toEqual(['a', 'b', 'c', 'd']);
    });
  });
});

// ─── Raw Ptr+Len Convention Regression ───────────────────────────────────────

describe('String Bridge ABI — raw ptr+len convention (non-LP functions)', () => {
  it('string_substring reads content from (ptr, len) args, not LP-pointer', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const state = makeMockState(memory, 1024);
    const bridge = createStringBridge(() => state);

    // Write raw UTF-8 bytes with no length prefix at a known address
    const rawAddr = 100;
    const bytes = new TextEncoder().encode('abcdefgh');
    new Uint8Array(memory.buffer).set(bytes, rawAddr);

    const resultPtr = bridge.string_substring(rawAddr, 8, 2, 5);
    expect(readLengthPrefixedString(memory, resultPtr)).toBe('cde');
  });

  it('string_to_upper reads content from (ptr, len) args', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const state = makeMockState(memory, 1024);
    const bridge = createStringBridge(() => state);

    const rawAddr = 200;
    const bytes = new TextEncoder().encode('hello');
    new Uint8Array(memory.buffer).set(bytes, rawAddr);

    const resultPtr = bridge.string_to_upper(rawAddr, 5);
    expect(readLengthPrefixedString(memory, resultPtr)).toBe('HELLO');
  });
});
