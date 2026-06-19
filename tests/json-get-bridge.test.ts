/**
 * _json_get bridge contract tests — NSR002 triage.
 *
 * Validates that the dot-path walker:
 *   - returns empty for out-of-bounds array indices (loop termination contract)
 *   - returns empty for missing object keys
 *   - returns raw strings for leaf string values (not JSON-quoted)
 *   - handles multibyte UTF-8 (em-dash, arrow, CJK) without corruption
 *   - matches the Rust clean-server _json_get behavior so the same WASM
 *     produces the same result on both hosts
 *
 * The NSR002 report claims that on Ubuntu/macOS Node a Clean Language loop of
 * the form:
 *   while title != ""
 *     title = json.get(sectionJson, "items." + i.toString() + ".title")
 * never terminates on data containing multibyte UTF-8, while it does on Alpine
 * Node and on Rust clean-server with the byte-identical WASM. If the bridge
 * returns an empty string for the first out-of-bounds index, the loop
 * terminates correctly and the bug is elsewhere in the WASM-side string-compare
 * codegen, not in the bridge.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHttpServerBridge } from '../src/bridge/http-server';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
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
  return { exports, config: { verbose: false } } as unknown as WasmState;
}

describe('_json_get — path-walker contract (NSR002)', () => {
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createHttpServerBridge>;

  const ADDR_JSON = 64;
  const ADDR_PATH = 65_536;
  const HEAP_START = 131_072;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeMockState(memory, HEAP_START);
    bridge = createHttpServerBridge(() => state);
  });

  function callJsonGet(json: string, path: string): string {
    const jsonLen = writeRawAt(memory, ADDR_JSON, json);
    const pathLen = writeRawAt(memory, ADDR_PATH, path);
    const resultPtr = bridge._json_get(ADDR_JSON, jsonLen, ADDR_PATH, pathLen);
    return readLengthPrefixedString(memory, resultPtr);
  }

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
});
