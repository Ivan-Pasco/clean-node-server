/**
 * _json_get bridge contract tests — BRIDGE-JSON-GET-INTEGER-RETURNS-POINTER.
 *
 * Validates the compiler 0.33.55+ / frame.server 2.8.4+ plugin ABI:
 *   params  = ["any", "string"]  (expand_strings = false)
 *   returns = "any"
 *
 * The compiler emits a 2-arg call:
 *   _json_get(any_json_ptr: i32, path_lp_ptr: i32) -> any_result_ptr: i32
 *
 * `any` is a pointer to a 12-byte boxed struct:
 *   [tag@0: i32] [value1@4: i32] [value2@8: i32]
 *   Tags: 0=Null, 1=Integer, 2=Boolean, 3=Number(f64), 4=String, 5=List, 6=Object
 *
 * The regression that motivated this suite: the pre-fix bridge kept the old
 * 4-arg `(jsonPtr, jsonLen, pathPtr, pathLen)` shape and returned a raw
 * length-prefixed string pointer. When the compiler subsequently emitted
 * `raw.toInteger()`, `emit_unbox_any(String)` read tag@0 of the "any" (which
 * was actually the LP-string's 4-byte length prefix) and then unboxed value@4
 * as the string content bytes reinterpreted as i32 — producing the reported
 * ~148000/+320-stride pointer-shaped values instead of the parsed integer.
 *
 * The path-walker semantics (loop-termination via empty string, own-key access,
 * multibyte UTF-8 fidelity) remain unchanged — they now describe what the
 * bridge returns *inside* the boxed-Any envelope.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHttpServerBridge } from '../src/bridge/http-server';
import { readLengthPrefixedString, writeLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState, WasmExports } from '../src/types';

const ANY_TAG_STRING = 4;
const ANY_STRUCT_SIZE = 12;

function makeMockState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      // 8-byte alignment matches production writeLengthPrefixedString bump.
      heapPtr = (heapPtr + size + 7) & ~7;
      return ptr;
    },
  } as unknown as WasmExports;
  return { exports, config: { verbose: false } } as unknown as WasmState;
}

/**
 * Allocate a boxed-Any struct with tag=String and value=<lp-ptr>.
 * Mirrors what the compiler's `emit_box_any` emits on the caller side.
 */
function boxString(state: WasmState, str: string): number {
  const lpPtr = writeLengthPrefixedString(state.exports, str);
  const anyPtr = state.exports.malloc(ANY_STRUCT_SIZE);
  const view = new DataView(state.exports.memory.buffer);
  view.setUint32(anyPtr, ANY_TAG_STRING, true);   // tag @ 0
  view.setUint32(anyPtr + 4, lpPtr, true);        // value1 @ 4
  view.setUint32(anyPtr + 8, 0, true);            // value2 @ 8
  return anyPtr;
}

/**
 * Read a boxed-Any pointer's underlying string.
 * Only handles tag=String / tag=Null (empty) — the shapes _json_get emits.
 */
function unboxString(memory: WebAssembly.Memory, anyPtr: number): string {
  if (anyPtr === 0) return '';
  const view = new DataView(memory.buffer);
  const tag = view.getUint32(anyPtr, true);
  if (tag === 0) return ''; // Null
  if (tag !== ANY_TAG_STRING) {
    throw new Error(`Expected String tag (${ANY_TAG_STRING}), got ${tag}`);
  }
  const lpPtr = view.getUint32(anyPtr + 4, true);
  return readLengthPrefixedString(memory, lpPtr);
}

describe('_json_get — any-in/any-out contract (compiler 0.33.55+, frame.server 2.8.4+)', () => {
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createHttpServerBridge>;

  const HEAP_START = 131_072;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeMockState(memory, HEAP_START);
    bridge = createHttpServerBridge(() => state);
  });

  function callJsonGet(json: string, path: string): string {
    const anyJsonPtr = boxString(state, json);
    const pathLpPtr = writeLengthPrefixedString(state.exports, path);
    const anyResultPtr = bridge._json_get(anyJsonPtr, pathLpPtr);
    return unboxString(memory, anyResultPtr);
  }

  function callJsonGetRaw(json: string, path: string): number {
    const anyJsonPtr = boxString(state, json);
    const pathLpPtr = writeLengthPrefixedString(state.exports, path);
    return bridge._json_get(anyJsonPtr, pathLpPtr);
  }

  it('returns a boxed-Any struct (12-byte header with tag=4=String) not a raw LP-string ptr', () => {
    // The regression: the pre-fix bridge returned an LP-string pointer directly.
    // The compiler-side `emit_unbox_any(String)` reads `[tag@0]` and expects it
    // to equal AnyTypeTag::String (4). An LP-string's first 4 bytes are its
    // byte length — small numbers like 1 ("7") — which the compiler then
    // interpreted as a Null/Integer tag, walking off into pointer-shaped
    // garbage on the subsequent `.toInteger()`.
    const ptr = callJsonGetRaw('{"n":"7"}', 'n');
    expect(ptr).not.toBe(0);
    const view = new DataView(memory.buffer);
    const tag = view.getUint32(ptr, true);
    expect(tag).toBe(ANY_TAG_STRING);
    // value1 must point at a well-formed LP-string containing "7".
    const lpPtr = view.getUint32(ptr + 4, true);
    expect(readLengthPrefixedString(memory, lpPtr)).toBe('7');
  });

  it('returns empty string for an out-of-bounds array index', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}` }));
    const json = JSON.stringify({ items });
    expect(callJsonGet(json, 'items.29.title')).toBe('t29');
    expect(callJsonGet(json, 'items.30.title')).toBe('');
    expect(callJsonGet(json, 'items.31.title')).toBe('');
    expect(callJsonGet(json, 'items.999.title')).toBe('');
  });

  it('returns empty for missing intermediate object key', () => {
    const json = '{"items":[{"title":"a"}]}';
    expect(callJsonGet(json, 'missing.0.title')).toBe('');
    expect(callJsonGet(json, 'items.0.missing')).toBe('');
  });

  it('returns raw string for leaf string (no JSON quotes)', () => {
    const json = '{"a":"hello"}';
    expect(callJsonGet(json, 'a')).toBe('hello');
  });

  it('handles multibyte UTF-8 in values (em-dash, arrow, CJK)', () => {
    const items = [
      { title: 'GET / → 200 Hello, World!' },
      { title: '— plain dash —' },
      { title: '世界、こんにちは' },
    ];
    const json = JSON.stringify({ items });
    expect(callJsonGet(json, 'items.0.title')).toBe('GET / → 200 Hello, World!');
    expect(callJsonGet(json, 'items.1.title')).toBe('— plain dash —');
    expect(callJsonGet(json, 'items.2.title')).toBe('世界、こんにちは');
    expect(callJsonGet(json, 'items.3.title')).toBe('');
  });

  it('terminates the user-reported loop pattern with multibyte titles', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `Item ${i} →`,
      extra_json: '{"foo":"bar — baz"}',
    }));
    const json = JSON.stringify({ items });

    let acc = '';
    let i = 0;
    let title = callJsonGet(json, `items.${i}.title`);
    let iterations = 0;
    while (title !== '') {
      if (++iterations > 1000) {
        throw new Error('Loop did not terminate within 1000 iterations');
      }
      acc += title;
      i++;
      title = callJsonGet(json, `items.${i}.title`);
    }
    expect(iterations).toBe(30);
    expect(acc.length).toBeGreaterThan(0);
  });

  it('returns empty for paths into a non-object intermediate (number, bool)', () => {
    const json = '{"count":5,"flag":true}';
    expect(callJsonGet(json, 'count.foo')).toBe('');
    expect(callJsonGet(json, 'flag.foo')).toBe('');
  });

  it('does NOT return Array.prototype methods for path parts like "push"', () => {
    const json = '{"items":[{"a":1},{"a":2}]}';
    expect(callJsonGet(json, 'items.push')).toBe('');
    expect(callJsonGet(json, 'items.length')).toBe('');
    expect(callJsonGet(json, 'items.constructor')).toBe('');
  });

  it('reproduces the reported COUNT(*) case: numeric-string leaf survives round-trip through toInteger', () => {
    // Reporter's minimal repro (paraphrased): a SQL COUNT(*) result whose
    // "total" field is a numeric string like "7" was rendering as pointer-shaped
    // values (148296, 148616, …) after `raw.toInteger()`. The bridge itself
    // now returns the correct boxed-Any envelope; parsing that string as an
    // integer is a caller-side concern, but we assert here that the string
    // survives the round-trip verbatim so the caller has correct input to parse.
    const json = JSON.stringify({ data: { rows: [{ total: '7' }] } });
    expect(callJsonGet(json, 'data.rows.0.total')).toBe('7');

    // Successive calls must not produce stride-shaped values (the +320 symptom).
    // Two identical calls should yield the same string; the pointer identity is
    // allowed to differ because each call allocates a fresh boxed-Any envelope.
    expect(callJsonGet(json, 'data.rows.0.total')).toBe('7');
  });
});
