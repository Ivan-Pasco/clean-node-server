/**
 * NODE-SERVER-BRIDGE-OOB-TASKS-FILTER — regression harness for the
 * "same WASM, different bridge" crash where node-server traps
 * "memory access out of bounds" on a request pattern that clean-server
 * (Rust bridge) handles cleanly.
 *
 * Pattern: `db.query` with parameterized WHERE → `while` loop of `json.get`
 * calls to render rows into an HTML accumulator via `string.concat`.
 *
 * Reporter's environment observations:
 *   - node-server 0.1.85 traps with OOB on the request
 *   - Same WASM runs cleanly on clean-server (Rust bridge) → bug is host-side
 *   - `bumpHeapPtrPastAllocation` never fires: WASM's own __malloc is
 *     already advancing __heap_ptr correctly
 *
 * Investigation as of 2026-07-11:
 *   - Booting node-server 0.1.85 against clean-errors/dist/errors.wasm and
 *     hitting /tasks?origin=error 20× sequential + 10× concurrent all
 *     returned HTTP 200. Bug could not be reproduced end-to-end.
 *   - Compiler had multiple "row-loop corruption" fixes on 2026-07-10
 *     (0.33.41, 0.33.45) which likely address the codegen path the report
 *     was tripping. The reporter's WASM predates those fixes.
 *
 * What this file does:
 *   Exercises the exact bridge-call sequence a compiler-emitted handler
 *   makes for that pattern:
 *     1. Two consecutive `_db_query` calls (count SELECT, then list SELECT)
 *     2. A while-loop of `_json_get` calls against the list response
 *     3. `string.concat` chain building an HTML accumulator
 *     4. A final wrap in <table>...</table>
 *
 *   Pins:
 *   - The bridge sequence does not corrupt LP-string headers under a
 *     healthy allocator (matches WASM __malloc post-0.30.321 behavior)
 *   - `_db_query` returns a valid `{ok:false,...}` envelope on driver
 *     errors — not raw bytes that could be misread as a success payload
 *   - Sequential `_db_query` responses are non-overlapping
 *
 *   If a future bridge change silently regresses this behavior (e.g.
 *   removes the writeString post-malloc guard, or changes _json_get's
 *   return semantics), one of these will start failing before it hits
 *   production again.
 */

import { describe, it, expect } from 'vitest';
import { createDatabaseBridge } from '../src/bridge/database';
import { createHttpServerBridge } from '../src/bridge/http-server';
import { createStringBridge } from '../src/bridge/string';
import {
  readLengthPrefixedString,
  writeLengthPrefixedString,
} from '../src/wasm/memory';
import type {
  WasmState,
  WasmResponse,
  DatabaseDriver,
  DbResult,
} from '../src/types';

function defaultResponse(): WasmResponse {
  return { status: 200, headers: {}, body: '', cookies: [] };
}

/**
 * WasmState with a bump allocator that advances __heap_ptr on every malloc,
 * matching the compiler ≥ 0.30.321 contract that this WASM was built under.
 */
function makeState(memory: WebAssembly.Memory, driver: DatabaseDriver): WasmState {
  const heapGlobal = new WebAssembly.Global(
    { value: 'i32', mutable: true },
    4096,
  );
  const exports = {
    memory,
    __heap_ptr: heapGlobal,
    malloc: (size: number): number => {
      const ptr = heapGlobal.value as number;
      heapGlobal.value = (ptr + size + 7) & ~7;
      return ptr;
    },
  } as unknown as WasmState['exports'];

  return {
    exports,
    instance: { exports } as unknown as WebAssembly.Instance,
    response: defaultResponse(),
    database: driver,
    config: { verbose: false } as WasmState['config'],
    lastInsertId: null,
    projectRoot: '/tmp',
  } as unknown as WasmState;
}

function callDbQuery(
  bridge: ReturnType<typeof createDatabaseBridge>,
  state: WasmState,
  sql: string,
  paramsJson: string,
): number {
  const sqlLp = writeLengthPrefixedString(state.exports, sql);
  const sqlLen = new DataView(state.exports.memory.buffer).getUint32(sqlLp, true);
  const paramsLp = writeLengthPrefixedString(state.exports, paramsJson);
  const paramsLen = new DataView(state.exports.memory.buffer).getUint32(paramsLp, true);
  return (bridge as any)._db_query(
    sqlLp + 4, sqlLen,
    paramsLp + 4, paramsLen,
  );
}

/**
 * Call _json_get using the compiler 0.33.55+ / frame.server 2.8.4+ ABI:
 *   (any_json_ptr, path_lp_ptr) -> any_result_ptr
 *
 * `sourceLp` is the LP-string pointer returned by `_db_query`; we box it here
 * as an Any (tag=4 String) the same way the compiler's `emit_box_any` would at
 * the caller side. Returns the LP-string pointer for the underlying result
 * (unboxing the Any envelope), or 0 for Null. Callers pass the returned LP-ptr
 * straight into `readLengthPrefixedString` / `string.concat` as before.
 */
function callJsonGet(
  bridge: ReturnType<typeof createHttpServerBridge>,
  state: WasmState,
  sourceLp: number,
  path: string,
): number {
  const anyJson = state.exports.malloc(12);
  const view = new DataView(state.exports.memory.buffer);
  view.setUint32(anyJson, 4, true);         // tag = String
  view.setUint32(anyJson + 4, sourceLp, true);
  view.setUint32(anyJson + 8, 0, true);
  const pathLp = writeLengthPrefixedString(state.exports, path);
  const anyResult = (bridge as any)._json_get(anyJson, pathLp);
  if (anyResult === 0) return 0;
  const resultView = new DataView(state.exports.memory.buffer);
  const tag = resultView.getUint32(anyResult, true);
  if (tag === 0) return 0;
  return resultView.getUint32(anyResult + 4, true);
}

describe('NODE-SERVER-BRIDGE-OOB-TASKS-FILTER — bridge-level regression harness', () => {
  it('count → list → json.get loop produces uncorrupted HTML', () => {
    const taskRow = {
      id: '1',
      origin: 'error',
      title: 'STAGE_TEST',
      status: 'open',
    };
    const memory = new WebAssembly.Memory({ initial: 4 });
    const queryCalls: { sql: string; params: unknown[] }[] = [];
    const driver: Partial<DatabaseDriver> = {
      querySync(sql: string, params: unknown[]): DbResult {
        queryCalls.push({ sql, params });
        if (/SELECT\s+CAST\(COUNT/i.test(sql)) {
          return { ok: true, data: { rows: [{ cnt: '1' }], count: 1 } };
        }
        return { ok: true, data: { rows: [taskRow], count: 1 } };
      },
    };
    const state = makeState(memory, driver as DatabaseDriver);
    const dbBridge = createDatabaseBridge(() => state);
    const httpBridge = createHttpServerBridge(() => state);
    const stringBridge = createStringBridge(() => state);

    const cntSql = 'SELECT CAST(COUNT(*) AS CHAR) as cnt FROM tasks WHERE 1=1 AND CAST(origin AS CHAR) = ?';
    const listSql =
      'SELECT CAST(task_id AS CHAR) as id, CAST(origin AS CHAR) as origin, ' +
      'title, CAST(status AS CHAR) as status FROM tasks ' +
      'WHERE 1=1 AND CAST(origin AS CHAR) = ? LIMIT 5';
    const params = '["error"]';

    const cntResult = callDbQuery(dbBridge, state, cntSql, params);
    expect(cntResult).toBeGreaterThan(0);

    const listResult = callDbQuery(dbBridge, state, listSql, params);
    expect(listResult).toBeGreaterThan(0);
    expect(queryCalls).toHaveLength(2);

    let html = writeLengthPrefixedString(state.exports, '');
    for (let i = 0; i < 5; i++) {
      const idPtr = callJsonGet(httpBridge, state, listResult, `data.rows.${i}.id`);
      const idView = new DataView(state.exports.memory.buffer);
      const idLen = idPtr === 0 ? 0 : idView.getUint32(idPtr, true);
      if (idLen === 0) break;

      const originPtr = callJsonGet(httpBridge, state, listResult, `data.rows.${i}.origin`);
      const titlePtr = callJsonGet(httpBridge, state, listResult, `data.rows.${i}.title`);

      const openTr = writeLengthPrefixedString(state.exports, '<tr><td>');
      html = stringBridge['string.concat'](html, openTr);
      html = stringBridge['string.concat'](html, idPtr);
      const td2 = writeLengthPrefixedString(state.exports, '</td><td>');
      html = stringBridge['string.concat'](html, td2);
      html = stringBridge['string.concat'](html, originPtr);
      const td3 = writeLengthPrefixedString(state.exports, '</td><td>');
      html = stringBridge['string.concat'](html, td3);
      html = stringBridge['string.concat'](html, titlePtr);
      const closeTr = writeLengthPrefixedString(state.exports, '</td></tr>');
      html = stringBridge['string.concat'](html, closeTr);
    }

    const openTable = writeLengthPrefixedString(state.exports, '<table>');
    const closeTable = writeLengthPrefixedString(state.exports, '</table>');
    let final = stringBridge['string.concat'](openTable, html);
    final = stringBridge['string.concat'](final, closeTable);

    const rendered = readLengthPrefixedString(memory, final);
    expect(rendered).toContain('STAGE_TEST');
    expect(rendered).toContain('error');
    expect(rendered.startsWith('<table>')).toBe(true);
    expect(rendered.endsWith('</table>')).toBe(true);
    expect(rendered).not.toMatch(/�/);
  });

  it('_db_query returns a parsable {ok:false} envelope on driver error', () => {
    // Hypothesis (a) from the report: if a driver error left non-envelope
    // bytes at the returned pointer, WASM callers doing `json.get(res, "ok")`
    // would misread them and later trap. Pin the invariant.
    const memory = new WebAssembly.Memory({ initial: 2 });
    const driver: Partial<DatabaseDriver> = {
      querySync(): DbResult {
        return {
          ok: false,
          err: { code: 'DB_ERROR', message: 'connection reset by peer' },
        };
      },
    };
    const state = makeState(memory, driver as DatabaseDriver);
    const dbBridge = createDatabaseBridge(() => state);
    const httpBridge = createHttpServerBridge(() => state);

    const ptr = callDbQuery(
      dbBridge,
      state,
      'SELECT * FROM t WHERE x = ?',
      '["v"]',
    );
    expect(ptr).toBeGreaterThan(0);

    const body = readLengthPrefixedString(memory, ptr);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.err?.code).toBe('DB_ERROR');

    const okPtr = callJsonGet(httpBridge, state, ptr, 'ok');
    expect(readLengthPrefixedString(memory, okPtr)).toBe('false');
  });

  it('sequential _db_query responses do not overlap', () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    let call = 0;
    const driver: Partial<DatabaseDriver> = {
      querySync(): DbResult {
        call += 1;
        return {
          ok: true,
          data: {
            rows: [{ id: String(call), label: `row-${call}` }],
            count: 1,
          },
        };
      },
    };
    const state = makeState(memory, driver as DatabaseDriver);
    const dbBridge = createDatabaseBridge(() => state);
    const httpBridge = createHttpServerBridge(() => state);

    const first = callDbQuery(dbBridge, state, 'SELECT * FROM a WHERE x = ?', '["1"]');
    const second = callDbQuery(dbBridge, state, 'SELECT * FROM b WHERE y = ?', '["2"]');

    const firstLabel = callJsonGet(httpBridge, state, first, 'data.rows.0.label');
    const secondLabel = callJsonGet(httpBridge, state, second, 'data.rows.0.label');
    expect(readLengthPrefixedString(memory, firstLabel)).toBe('row-1');
    expect(readLengthPrefixedString(memory, secondLabel)).toBe('row-2');
  });
});
