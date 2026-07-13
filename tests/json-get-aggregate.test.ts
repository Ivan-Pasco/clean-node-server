/**
 * BRIDGE-JSON-GET-INTEGER-RETURNS-POINTER-AGGREGATE-QUERY (#61ef80a34ec6)
 * — regression pin for node-server's half of a bug whose root cause is
 * COMPILER-SIDE (see the note below).
 *
 * The reporter observed that a sequence of
 *   integer total = json.get(r, "data.rows.0.total").toInteger()
 *   integer n_open = json.get(r, "data.rows.0.n_open").toInteger()
 *   integer n_ip = json.get(r, "data.rows.0.n_ip").toInteger()
 *   ...
 * produced pointer-shaped values with a fixed +320-byte stride between
 * successive results, and hypothesised that node-server's `_json_get` was
 * handing out Any envelopes whose `value1` slot pointed at overwritten
 * ("stale") memory.
 *
 * Root cause (traced 2026-07-12): the compiler's `emit_unbox_to_i32`
 * (clean-language-compiler mir_codegen/instructions.rs:2759) handles only
 *   tag == 3 (Number)  → read f64 at offset 4, truncate
 *   otherwise          → read i32 at offset 4 directly
 * When `_json_get` returns tag=4 (String) with `value1` = LP-string pointer,
 * the fall-through path reads `value1` as the integer — i.e. hands back the
 * raw pointer. Successive calls' pointers form the +320 stride the reporter
 * saw. There is no unbox path for tag=String → parseInt.
 *
 * The reporter's suggested fix ("audit the bridge for stale box slots") is
 * therefore misdiagnosed — the node-server bridge is correct, my tests below
 * prove it. The real fix is in compiler codegen: `emit_unbox_to_i32` must
 * grow a String-tag branch that reads the LP-string content and parses it.
 *
 * Filed upstream as a compiler bug (see cross-component prompt / report_error
 * emitted at the same time as this pin lands).
 *
 * What this suite pins on the node-server side (all four passing today):
 *   1. N sequential `_json_get` calls against the same single-row aggregate
 *      result each return a well-formed Any with the correct string leaf.
 *   2. Neither the Any envelopes nor their underlying LP-strings overlap
 *      across calls — the +320-stride overlap hypothesis is disproven at
 *      the bridge boundary.
 *   3. Successive returned Any pointers advance strictly forward.
 *   4. `__heap_ptr` is bumped past every allocation each call ends.
 * If any of these regress in the future, the pointer-shaped-integer symptom
 * really WOULD reappear at the bridge layer, and we want a clean red test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHttpServerBridge } from '../src/bridge/http-server';
import {
  readLengthPrefixedString,
  writeLengthPrefixedString,
  bumpHeapPtr,
} from '../src/wasm/memory';
import type { WasmState, WasmResponse } from '../src/types';

const ANY_TAG_STRING = 4;
const ANY_STRUCT_SIZE = 12;

function defaultResponse(): WasmResponse {
  return { status: 200, headers: {}, body: '', cookies: [] };
}

/**
 * Mock state that mirrors `nsr002-heap-ptr-overlap`'s buggy-malloc fixture:
 * every call to `malloc` re-syncs its internal bump pointer with the exported
 * `__heap_ptr` global. If a bridge helper forgets to bump the global, the
 * NEXT malloc regresses to the stale value and hands out a pointer that
 * overlaps the prior allocation — reproducing the +320 stride the reporter
 * observed in prod.
 */
function makeBuggyMallocState(memory: WebAssembly.Memory, heapStart: number): WasmState {
  let heapPtr = heapStart;
  const heapGlobal = new WebAssembly.Global(
    { value: 'i32', mutable: true },
    heapStart,
  );
  const exports = {
    memory,
    __heap_ptr: heapGlobal,
    malloc: (size: number): number => {
      heapPtr = heapGlobal.value as number;
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

/**
 * Box a JSON payload as Any(tag=String) — mirrors the compiler-emitted
 * `emit_box_any(String)` around a `string` variable at the json.get call site.
 * We box ONCE (matching the actual codegen for a stable `string r` binding).
 */
function boxJsonAsAny(state: WasmState, json: string): number {
  const lpPtr = writeLengthPrefixedString(state.exports, json);
  const anyPtr = state.exports.malloc(ANY_STRUCT_SIZE);
  const view = new DataView(state.exports.memory.buffer);
  view.setUint32(anyPtr, ANY_TAG_STRING, true);
  view.setUint32(anyPtr + 4, lpPtr, true);
  view.setUint32(anyPtr + 8, 0, true);
  bumpHeapPtr(state.exports, anyPtr, ANY_STRUCT_SIZE);
  return anyPtr;
}

/**
 * Read a String-tagged Any: verify tag@0=4, dereference value1@4 as LP-string.
 * Fails loudly if the envelope has been corrupted (e.g. tag no longer 4, or
 * value1 points at overwritten bytes yielding a bogus length prefix).
 */
function unboxAnyString(memory: WebAssembly.Memory, anyPtr: number): string {
  const view = new DataView(memory.buffer);
  const tag = view.getUint32(anyPtr, true);
  if (tag !== ANY_TAG_STRING) {
    throw new Error(
      `Any envelope corrupted: expected tag=String(4), got tag=${tag} at anyPtr=${anyPtr}`,
    );
  }
  const lpPtr = view.getUint32(anyPtr + 4, true);
  return readLengthPrefixedString(memory, lpPtr);
}

describe('BRIDGE-JSON-GET-INTEGER-RETURNS-POINTER-AGGREGATE-QUERY (#61ef80a34ec6)', () => {
  let memory: WebAssembly.Memory;
  let state: WasmState;
  let bridge: ReturnType<typeof createHttpServerBridge>;

  beforeEach(() => {
    memory = new WebAssembly.Memory({ initial: 4 });
    state = makeBuggyMallocState(memory, 4096);
    bridge = createHttpServerBridge(() => state);
  });

  it('N sequential json.get calls on the same aggregate result all decode correctly', () => {
    // The exact shape from tasks.cln:544-552 — 8 fields on a single-row
    // aggregate result. Each field is a CAST-AS-CHAR numeric string, as the
    // reporter's SQL emits.
    const aggregateJson = JSON.stringify({
      ok: true,
      data: {
        rows: [
          {
            total: '7',
            n_open: '3',
            n_ip: '2',
            n_ir: '2',
            n_done: '0',
            n_blocked: '0',
            n_high: '5',
            n_low: '2',
          },
        ],
      },
    });

    const anyJson = boxJsonAsAny(state, aggregateJson);

    // Replay the aggregate_stats sequence: 8 sequential json.get calls against
    // the same result. Under the buggy-malloc fixture, each fresh allocation
    // regresses to the stale __heap_ptr unless the bridge bumped it — so the
    // Any envelope allocated in call N would land on top of call N-1's LP-string
    // (or vice-versa), corrupting the earlier value1 slot.
    const fields = [
      'total', 'n_open', 'n_ip', 'n_ir',
      'n_done', 'n_blocked', 'n_high', 'n_low',
    ];
    const expected = ['7', '3', '2', '2', '0', '0', '5', '2'];

    const returnedAnys: number[] = [];
    for (const field of fields) {
      const pathLp = writeLengthPrefixedString(state.exports, `data.rows.0.${field}`);
      const anyResult = bridge._json_get(anyJson, pathLp);
      returnedAnys.push(anyResult);
    }

    // Each returned Any must still decode to its correct value AFTER the whole
    // sequence has finished. If a later allocation clobbered an earlier
    // envelope, the corresponding unbox would either trap on a bogus length
    // prefix or return the wrong string.
    for (let i = 0; i < returnedAnys.length; i++) {
      const decoded = unboxAnyString(memory, returnedAnys[i]);
      expect(decoded).toBe(expected[i]);
    }
  });

  it('Any envelopes and their LP-strings do not overlap across sequential calls', () => {
    // Direct pointer-arithmetic check: the +320 stride the reporter saw came
    // from consecutive Any-box slots being handed out at fixed offsets from
    // an un-advanced heap frontier. If the bridge bumps correctly, each fresh
    // allocation lands strictly AFTER every prior allocation's end address.
    const json = JSON.stringify({
      data: { rows: [{ a: '11', b: '22', c: '33', d: '44' }] },
    });
    const anyJson = boxJsonAsAny(state, json);

    const anys: number[] = [];
    for (const field of ['a', 'b', 'c', 'd']) {
      const pathLp = writeLengthPrefixedString(state.exports, `data.rows.0.${field}`);
      anys.push(bridge._json_get(anyJson, pathLp));
    }

    // Each Any's envelope AND its underlying LP-string must be disjoint from
    // every subsequent Any's envelope + LP-string.
    const view = new DataView(memory.buffer);
    const ranges: Array<{ start: number; end: number; label: string }> = [];
    for (let i = 0; i < anys.length; i++) {
      const anyPtr = anys[i];
      const lpPtr = view.getUint32(anyPtr + 4, true);
      const lpLen = view.getUint32(lpPtr, true);
      ranges.push({ start: anyPtr, end: anyPtr + ANY_STRUCT_SIZE, label: `Any#${i}` });
      ranges.push({ start: lpPtr, end: lpPtr + 4 + lpLen, label: `LP#${i}` });
    }
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i];
        const b = ranges[j];
        const overlap = a.start < b.end && b.start < a.end;
        expect(
          overlap,
          `${a.label} [${a.start}, ${a.end}) overlaps ${b.label} [${b.start}, ${b.end})`,
        ).toBe(false);
      }
    }
  });

  it('successive returned Any pointers advance strictly forward (no +320 stride regression)', () => {
    // The reporter's canonical symptom: consecutive Any pointers differ by a
    // FIXED negative or repeating stride (~320 bytes). Under a working bridge,
    // successive pointers must be strictly increasing.
    const json = JSON.stringify({
      data: { rows: [{ v0: '0', v1: '1', v2: '2', v3: '3', v4: '4' }] },
    });
    const anyJson = boxJsonAsAny(state, json);

    const anys: number[] = [];
    for (let i = 0; i < 5; i++) {
      const pathLp = writeLengthPrefixedString(state.exports, `data.rows.0.v${i}`);
      anys.push(bridge._json_get(anyJson, pathLp));
    }

    for (let i = 1; i < anys.length; i++) {
      expect(anys[i]).toBeGreaterThan(anys[i - 1]);
    }

    // And each must still decode correctly after all five have been allocated.
    for (let i = 0; i < anys.length; i++) {
      expect(unboxAnyString(memory, anys[i])).toBe(String(i));
    }
  });

  it('__heap_ptr is bumped past every _json_get allocation', () => {
    // Contract-level pin: after any _json_get call, the exported __heap_ptr
    // global must sit at or beyond the end of both the returned Any envelope
    // and its underlying LP-string. This is the invariant that prevents the
    // next allocation from regressing onto a live slot.
    const json = JSON.stringify({ data: { rows: [{ x: 'forty-two' }] } });
    const anyJson = boxJsonAsAny(state, json);

    const pathLp = writeLengthPrefixedString(state.exports, 'data.rows.0.x');
    const anyResult = bridge._json_get(anyJson, pathLp);

    const view = new DataView(memory.buffer);
    const lpPtr = view.getUint32(anyResult + 4, true);
    const lpLen = view.getUint32(lpPtr, true);
    const anyEnd = (anyResult + ANY_STRUCT_SIZE + 7) & ~7;
    const lpEnd = (lpPtr + 4 + lpLen + 7) & ~7;
    const frontier = Math.max(anyEnd, lpEnd);

    const heapGlobal = state.exports.__heap_ptr as WebAssembly.Global;
    expect(heapGlobal.value as number).toBeGreaterThanOrEqual(frontier);
  });
});
