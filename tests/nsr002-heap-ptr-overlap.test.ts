/**
 * NSR002 follow-up — bridge mallocs must defensively bump `__heap_ptr`
 * to prevent overlapping allocations when the WASM `__malloc` fails to
 * advance the global itself.
 *
 * Root cause of the OOB trap that persisted after 7679a9e:
 *
 *   The compiler's emitted `__malloc` uses the `__heap_ptr` exported global as
 *   the bump pointer. When malloc is re-entered from a host bridge function
 *   (which is exactly what happens during `string.concat`, `string_split`,
 *   `_json_get`, etc.), the global isn't always advanced by the time control
 *   returns to the bridge. The next bridge call's malloc then returns the
 *   SAME (or overlapping) pointer, and the second write silently corrupts the
 *   first allocation's length prefix. The next time WASM reads the first
 *   string, it gets a length from corrupted bytes — typically a huge value —
 *   and tries to read that many bytes, hitting OOB.
 *
 *   Clean-server's Rust bridge guards against this in every allocator helper
 *   (`write_string_to_caller`, `write_bytes_to_caller`,
 *   `write_string_list_to_caller`): it reads `__heap_ptr` after malloc, and
 *   if it's lower than `(ptr + size + 7) & ~7` (8-byte aligned past the
 *   allocation), it forcibly bumps the global. Node-server lacked this
 *   guard — these tests pin the contract so it can never drift again.
 *
 *   See clean-server/host-bridge/src/wasm_linker/helpers.rs:163-236 for the
 *   reference implementation.
 *
 * The mock here simulates the bug by giving `malloc` a per-call bump but
 * intentionally leaving `__heap_ptr` STALE (never advanced beyond its initial
 * value). Without the fix, the second writeString returns a pointer that
 * overlaps the first; with the fix, the bridge forcibly bumps `__heap_ptr`
 * after each allocation, breaking the overlap chain.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createStringBridge } from '../src/bridge/string';
import { createHttpServerBridge } from '../src/bridge/http-server';
import {
  readLengthPrefixedString,
  writeLengthPrefixedString,
  bumpHeapPtr,
} from '../src/wasm/memory';
import type { WasmState, WasmResponse } from '../src/types';

function defaultResponse(): WasmResponse {
  return { status: 200, headers: {}, body: '', cookies: [] };
}

/**
 * Mock state where the WASM `__malloc` bumps its OWN internal pointer (so
 * consecutive mallocs from inside one function get distinct pointers) but
 * does NOT advance the `__heap_ptr` global. This is the exact pathology
 * the bridge defensive-bump must compensate for.
 */
function makeBuggyMallocState(
  memory: WebAssembly.Memory,
  heapStart: number,
): WasmState {
  let heapPtr = heapStart;
  // The exported global stays at heapStart unless the bridge bumps it.
  const heapGlobal = new WebAssembly.Global(
    { value: 'i32', mutable: true },
    heapStart,
  );
  const exports = {
    memory,
    __heap_ptr: heapGlobal,
    malloc: (size: number): number => {
      // Synchronize the internal bump pointer with the global on every call.
      // If the bridge forgot to bump the global, the internal pointer
      // *regresses* to the global's stale value — reproducing the prod bug
      // where successive mallocs hand out overlapping pointers.
      heapPtr = heapGlobal.value;
      const ptr = heapPtr;
      heapPtr += size;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return {
    exports,
    instance: { exports } as unknown as WebAssembly.Instance,
    response: defaultResponse(),
    config: { verbose: false },
  } as unknown as WasmState;
}

describe('NSR002 — bridge must bump __heap_ptr to prevent allocator overlap', () => {
  let memory: WebAssembly.Memory;
  let state: WasmState;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeBuggyMallocState(memory, 4096);
  });

  it('consecutive writeLengthPrefixedString calls produce non-overlapping pointers', () => {
    // Without the bridge-side defensive bump, the second call would reuse
    // the first call's address because __heap_ptr never moved.
    const a = writeLengthPrefixedString(state.exports, 'first allocation');
    const b = writeLengthPrefixedString(state.exports, 'second longer allocation');

    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    // Both must round-trip — proves the second write didn't clobber the first.
    expect(readLengthPrefixedString(memory, a)).toBe('first allocation');
    expect(readLengthPrefixedString(memory, b)).toBe('second longer allocation');
    // And the addresses must actually be distinct.
    expect(b).not.toBe(a);
    expect(b).toBeGreaterThanOrEqual(a + 4 + 'first allocation'.length);
  });

  it('30-card concat loop: each accumulator step survives without length-prefix corruption', () => {
    // This mirrors the prod /tutorials render loop. Each iteration:
    //   - emits a small fragment via writeString
    //   - concats it onto an accumulator via string.concat
    // Without the heap-ptr bump, the concat result's length prefix gets
    // overwritten by the NEXT fragment's writeString, yielding a corrupted
    // length on the next read — which is exactly the symptom on prod
    // (the byte at index 1 reads as 0xB6 instead of valid UTF-8).
    const bridge = createStringBridge(() => state);

    let acc = writeLengthPrefixedString(state.exports, '');
    for (let i = 0; i < 30; i++) {
      const fragment = writeLengthPrefixedString(state.exports, `Card ${i} `);
      acc = bridge['string.concat'](acc, fragment);

      // After each iteration, the accumulator MUST decode back to a valid
      // string. Pre-fix this fails around iteration 1–2 because the
      // accumulator's length prefix gets clobbered by the next writeString.
      const decoded = readLengthPrefixedString(memory, acc);
      expect(decoded).not.toMatch(/�/);
      expect(decoded.endsWith(`Card ${i} `)).toBe(true);
    }

    const finalDecoded = readLengthPrefixedString(memory, acc);
    expect(finalDecoded.split('Card').length - 1).toBe(30);
  });

  it('_json_get → string.concat chain (the prod /tutorials 30-card pattern)', () => {
    // The actual render loop: query DB → JSON, then `iterate item in items`
    // pulling fields via _json_get and concatenating into an HTML accumulator.
    // Each _json_get call returns a fresh boxed-Any pointer (12-byte struct
    // with tag=4 String, value1 = LP-string ptr); the caller unboxes to a
    // string LP-ptr before feeding it into string.concat. Without the heap-ptr
    // bump, either the Any envelope OR the underlying LP-string can be
    // overwritten by the NEXT _json_get before the concat reads them,
    // producing a length-prefix corruption that surfaces as a WASM OOB trap
    // when the compiler-emitted accumulator tries to walk the corrupted length.
    //
    // ABI change (compiler 0.33.55+, frame.server 2.8.4+): _json_get is now
    // (any_json_ptr, path_lp_ptr) -> any_result_ptr. See BRIDGE-JSON-GET-
    // INTEGER-RETURNS-POINTER for the migration rationale.
    const httpBridge = createHttpServerBridge(() => state);
    const stringBridge = createStringBridge(() => state);

    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `Tutorial ${i}`,
      slug: `slug-${i}`,
    }));
    const dbResult = { ok: true, data: { rows: items, count: items.length } };

    // Box the DB-result JSON string as an Any (tag=4 String, value1=lp-ptr) —
    // this is what the compiler's `emit_box_any` produces at the call site.
    // The bumpHeapPtr call after the malloc is critical under this test's
    // deliberately-stale __heap_ptr fixture: without it the very next
    // writeLengthPrefixedString would re-issue the same address and clobber
    // the envelope we just wrote.
    const dbLp = writeLengthPrefixedString(state.exports, JSON.stringify(dbResult));
    const anyJson = state.exports.malloc(12);
    {
      const view = new DataView(memory.buffer);
      view.setUint32(anyJson, 4, true);      // tag = String
      view.setUint32(anyJson + 4, dbLp, true);
      view.setUint32(anyJson + 8, 0, true);
      bumpHeapPtr(state.exports, anyJson, 12);
    }

    let acc = writeLengthPrefixedString(state.exports, '');
    for (let i = 0; i < 30; i++) {
      const titlePath = `data.rows.${i}.title`;
      const pathLp = writeLengthPrefixedString(state.exports, titlePath);

      const anyTitle = httpBridge._json_get(anyJson, pathLp);
      // Unbox the returned Any to its underlying LP-string ptr, which is what
      // string.concat expects (LP-pointer calling convention).
      const view = new DataView(memory.buffer);
      const titleLp = view.getUint32(anyTitle + 4, true);
      acc = stringBridge['string.concat'](acc, titleLp);

      // The accumulator's tail must be the title we just appended — if a
      // subsequent allocation clobbered the json result before concat ran,
      // we'd see garbage here.
      const decoded = readLengthPrefixedString(memory, acc);
      expect(decoded.endsWith(`Tutorial ${i}`)).toBe(true);
    }

    const final = readLengthPrefixedString(memory, acc);
    for (let i = 0; i < 30; i++) {
      expect(final).toContain(`Tutorial ${i}`);
    }
  });

  it('string_split element pointers survive subsequent writeString calls', () => {
    // string_split allocates N element strings then a list block. Without
    // the defensive bump, the list block's malloc would overlap with the
    // last element string's bytes — the compiler's `iterate part in parts`
    // would then read a corrupted element pointer and trap.
    const bridge = createStringBridge(() => state);

    const srcLp = writeLengthPrefixedString(state.exports, 'a|b|c|d|e|f|g|h|i|j');
    const delimLp = writeLengthPrefixedString(state.exports, '|');

    const listPtr = bridge.string_split(srcLp, delimLp);
    expect(listPtr).toBeGreaterThan(0);

    // Now force more allocations — under the bug, these would overlap with
    // the element strings the list still references.
    for (let i = 0; i < 10; i++) {
      writeLengthPrefixedString(state.exports, `padding-allocation-${i}`);
    }

    const view = new DataView(memory.buffer);
    const length = view.getUint32(listPtr, true);
    expect(length).toBe(10);

    // Walk the list as the compiler's `iterate` would.
    const decoded: string[] = [];
    for (let i = 0; i < length; i++) {
      const elemPtr = view.getUint32(listPtr + 16 + i * 4, true);
      decoded.push(readLengthPrefixedString(memory, elemPtr));
    }
    expect(decoded).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  });

  it('parity with clean-server: __heap_ptr is bumped to (ptr + size + 7) & ~7', () => {
    // Pins the 8-byte alignment rule clean-server uses
    // (host-bridge/src/wasm_linker/helpers.rs:221). If a future change
    // weakens the alignment (e.g. 4-byte) some compiler allocations of f64
    // values would land unaligned.
    const heapGlobal = state.exports.__heap_ptr as WebAssembly.Global;
    const before = heapGlobal.value as number;

    const ptr = writeLengthPrefixedString(state.exports, 'abc');
    const totalSize = 4 + 3;

    const expected = (ptr + totalSize + 7) & ~7;
    expect(heapGlobal.value).toBeGreaterThanOrEqual(expected);
    // And the bump must be strictly past the prior value.
    expect(heapGlobal.value).toBeGreaterThan(before);
  });
});
