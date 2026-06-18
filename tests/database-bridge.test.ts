/**
 * Database bridge tests — safety guards for _db_paginate and _db_valid_field.
 *
 * These hit the bridge via createDatabaseBridge with a mock driver so we can
 * verify the SQL that gets generated without standing up a real database.
 * The interesting paths are the identifier validation and WHERE-clause
 * construction — they're security-critical (anti-SQL-injection) and easy to
 * regress when refactoring.
 */

import { describe, it, expect } from 'vitest';
import {
  createDatabaseBridge,
  lastInsertIdAlias,
  lastInsertIdResponse,
  isInsert,
} from '../src/bridge/database';
import type { WasmState, DatabaseDriver, DbResult, DbExecuteResult } from '../src/types';

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface MockState {
  state: WasmState;
  calls: QueryCall[];
  result: WasmState;
}

function makeMockState(opts: {
  // For paginate: items query result then count query result, applied in order
  results: DbResult[];
}): { state: WasmState; calls: QueryCall[] } {
  const memory = new WebAssembly.Memory({ initial: 2 });
  let heapPtr = 16384;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];

  const calls: QueryCall[] = [];
  let resultIdx = 0;
  const driver: Partial<DatabaseDriver> = {
    querySync(sql: string, params: unknown[]): DbResult {
      calls.push({ sql, params });
      return opts.results[resultIdx++] ?? { ok: true, data: { rows: [], count: 0 } };
    },
  };

  const state: WasmState = {
    exports,
    projectRoot: '/tmp',
    database: driver as DatabaseDriver,
  } as unknown as WasmState;

  return { state, calls };
}

function writeRaw(memory: WebAssembly.Memory, ptr: number, str: string): { ptr: number; len: number } {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

describe('_db_valid_field', () => {
  it('rejects identifiers with SQL metacharacters', () => {
    const { state } = makeMockState({ results: [{ ok: true, data: { rows: [], count: 0 } }] });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'users');
    const evil = writeRaw(memory, 1100, 'id; DROP TABLE users; --');

    const result = (bridge as any)._db_valid_field(
      table.ptr, table.len, evil.ptr, evil.len,
    );
    expect(result).toBe(0);
  });

  it('passes a safe identifier through to the schema check', () => {
    const { state, calls } = makeMockState({
      results: [{ ok: true, data: { rows: [], count: 0 } }],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'users');
    const field = writeRaw(memory, 1100, 'created_at');

    const result = (bridge as any)._db_valid_field(
      table.ptr, table.len, field.ptr, field.len,
    );
    expect(result).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('SELECT created_at FROM users LIMIT 0');
  });

  it('returns 0 when the driver reports the field is unknown', () => {
    const { state } = makeMockState({
      results: [{ ok: false, err: { code: 'NO_COLUMN', message: 'unknown column' } }],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'users');
    const field = writeRaw(memory, 1100, 'imaginary_col');

    const result = (bridge as any)._db_valid_field(
      table.ptr, table.len, field.ptr, field.len,
    );
    expect(result).toBe(0);
  });
});

describe('_db_paginate', () => {
  it('builds parameterized SQL with LIMIT/OFFSET and a flat WHERE object', () => {
    const { state, calls } = makeMockState({
      results: [
        { ok: true, data: { rows: [{ id: 1 }, { id: 2 }], count: 2 } },
        { ok: true, data: { rows: [{ total: 42 }], count: 1 } },
      ],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'orders');
    const where = writeRaw(memory, 1100, '{"status":"paid","user_id":5}');

    (bridge as any)._db_paginate(
      table.ptr, table.len,
      where.ptr, where.len,
      2n, // page (1-based)
      10n, // per_page
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toBe('SELECT * FROM orders WHERE status = ? AND user_id = ? LIMIT ? OFFSET ?');
    expect(calls[0].params).toEqual(['paid', 5, 10, 10]); // offset = (page-1)*per_page = 10
    expect(calls[1].sql).toBe('SELECT COUNT(*) AS total FROM orders WHERE status = ? AND user_id = ?');
    expect(calls[1].params).toEqual(['paid', 5]);
  });

  it('rejects malicious table names without touching the driver', () => {
    const { state, calls } = makeMockState({ results: [] });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'orders; DROP TABLE users;');
    const where = writeRaw(memory, 1100, '{}');

    (bridge as any)._db_paginate(table.ptr, table.len, where.ptr, where.len, 1n, 10n);
    expect(calls).toHaveLength(0);
  });

  it('rejects malicious WHERE column names without touching the driver', () => {
    const { state, calls } = makeMockState({ results: [] });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'orders');
    const where = writeRaw(memory, 1100, '{"id; DROP TABLE x; --": 1}');

    (bridge as any)._db_paginate(table.ptr, table.len, where.ptr, where.len, 1n, 10n);
    expect(calls).toHaveLength(0);
  });

  it('handles empty WHERE clause', () => {
    const { state, calls } = makeMockState({
      results: [
        { ok: true, data: { rows: [{ id: 1 }], count: 1 } },
        { ok: true, data: { rows: [{ total: 100 }], count: 1 } },
      ],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'logs');
    (bridge as any)._db_paginate(table.ptr, table.len, 0, 0, 1n, 25n);

    expect(calls[0].sql).toBe('SELECT * FROM logs  LIMIT ? OFFSET ?');
    expect(calls[0].params).toEqual([25, 0]);
    expect(calls[1].sql).toBe('SELECT COUNT(*) AS total FROM logs ');
    expect(calls[1].params).toEqual([]);
  });

  it('clamps per_page to a sane upper bound', () => {
    const { state, calls } = makeMockState({
      results: [
        { ok: true, data: { rows: [], count: 0 } },
        { ok: true, data: { rows: [{ total: 0 }], count: 1 } },
      ],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'rows');
    (bridge as any)._db_paginate(table.ptr, table.len, 0, 0, 1n, 999999n);

    expect(calls[0].params).toEqual([1000, 0]); // clamped from 999999 to 1000
  });

  // Reserved-key protocol — see DB-BUILD-WHERE-IGNORES-DUNDER-WHERE.
  // The framework's frame.data plugin emits `{"__where":"<sql_fragment>"}` for
  // Model.paginate: / Model.cursor: where: blocks containing operators like
  // `!= null` or `> x`. The bridge must append that fragment as raw SQL, not
  // bind it as `WHERE __where = ?`. `__order` is the matching reserved key for
  // ORDER BY.
  it('honors __where as a raw SQL fragment in the where_json envelope', () => {
    const { state, calls } = makeMockState({
      results: [
        { ok: true, data: { rows: [], count: 0 } },
        { ok: true, data: { rows: [{ total: 0 }], count: 1 } },
      ],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'posts');
    const where = writeRaw(memory, 1100, '{"__where":"published_at IS NOT NULL"}');

    (bridge as any)._db_paginate(table.ptr, table.len, where.ptr, where.len, 1n, 10n);

    expect(calls[0].sql).toBe('SELECT * FROM posts WHERE published_at IS NOT NULL LIMIT ? OFFSET ?');
    expect(calls[0].params).toEqual([10, 0]);
    expect(calls[1].sql).toBe('SELECT COUNT(*) AS total FROM posts WHERE published_at IS NOT NULL');
    expect(calls[1].params).toEqual([]);
  });

  it('combines __where with regular column equality filters', () => {
    const { state, calls } = makeMockState({
      results: [
        { ok: true, data: { rows: [], count: 0 } },
        { ok: true, data: { rows: [{ total: 0 }], count: 1 } },
      ],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'posts');
    const where = writeRaw(memory, 1100, '{"author_id":7,"__where":"published_at > NOW()"}');

    (bridge as any)._db_paginate(table.ptr, table.len, where.ptr, where.len, 1n, 5n);

    expect(calls[0].sql).toBe('SELECT * FROM posts WHERE author_id = ? AND published_at > NOW() LIMIT ? OFFSET ?');
    expect(calls[0].params).toEqual([7, 5, 0]);
  });

  it('honors __order as a raw ORDER BY fragment', () => {
    const { state, calls } = makeMockState({
      results: [
        { ok: true, data: { rows: [], count: 0 } },
        { ok: true, data: { rows: [{ total: 0 }], count: 1 } },
      ],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'posts');
    const where = writeRaw(memory, 1100, '{"__order":"created_at DESC"}');

    (bridge as any)._db_paginate(table.ptr, table.len, where.ptr, where.len, 1n, 10n);

    expect(calls[0].sql).toBe('SELECT * FROM posts  ORDER BY created_at DESC LIMIT ? OFFSET ?');
    expect(calls[0].params).toEqual([10, 0]);
    expect(calls[1].sql).toBe('SELECT COUNT(*) AS total FROM posts ');
  });

  it('honors __where and __order together', () => {
    const { state, calls } = makeMockState({
      results: [
        { ok: true, data: { rows: [], count: 0 } },
        { ok: true, data: { rows: [{ total: 0 }], count: 1 } },
      ],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'posts');
    const where = writeRaw(memory, 1100, '{"__where":"published_at IS NOT NULL","__order":"id ASC"}');

    (bridge as any)._db_paginate(table.ptr, table.len, where.ptr, where.len, 1n, 10n);

    expect(calls[0].sql).toBe('SELECT * FROM posts WHERE published_at IS NOT NULL ORDER BY id ASC LIMIT ? OFFSET ?');
  });

  it('rejects __order containing SQL metacharacters', () => {
    const { state, calls } = makeMockState({ results: [] });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'posts');
    const where = writeRaw(memory, 1100, '{"__order":"id; DROP TABLE x; --"}');

    (bridge as any)._db_paginate(table.ptr, table.len, where.ptr, where.len, 1n, 10n);
    expect(calls).toHaveLength(0);
  });
});

describe('_db_cursor_page', () => {
  it('builds ORDER BY + cursor predicate and detects has_more', () => {
    const { state, calls } = makeMockState({
      results: [
        // Returns per_page+1 rows → has_more = true
        {
          ok: true,
          data: {
            rows: [
              { id: 11, name: 'a' },
              { id: 12, name: 'b' },
              { id: 13, name: 'c' },
            ],
            count: 3,
          },
        },
      ],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'items');
    const after = writeRaw(memory, 1200, '10');
    const byField = writeRaw(memory, 1300, 'id');

    const ptr = (bridge as any)._db_cursor_page(
      table.ptr, table.len,
      0, 0,
      2n, // per_page = 2; SQL asks for 3 to detect more
      after.ptr, after.len,
      byField.ptr, byField.len,
    );
    expect(ptr).toBeGreaterThan(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('SELECT * FROM items WHERE id > ? ORDER BY id ASC LIMIT ?');
    expect(calls[0].params).toEqual(['10', 3]);
  });

  it('omits cursor predicate on the first page (after = "")', () => {
    const { state, calls } = makeMockState({
      results: [{ ok: true, data: { rows: [{ id: 1 }], count: 1 } }],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'items');
    const byField = writeRaw(memory, 1200, 'id');

    (bridge as any)._db_cursor_page(
      table.ptr, table.len,
      0, 0,
      10n,
      0, 0, // no cursor
      byField.ptr, byField.len,
    );

    expect(calls[0].sql).toBe('SELECT * FROM items  ORDER BY id ASC LIMIT ?');
    expect(calls[0].params).toEqual([11]);
  });

  it('honors __where reserved key in cursor where_json envelope', () => {
    const { state, calls } = makeMockState({
      results: [{ ok: true, data: { rows: [], count: 0 } }],
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'items');
    const where = writeRaw(memory, 1100, '{"__where":"price > 100"}');
    const byField = writeRaw(memory, 1300, 'id');

    (bridge as any)._db_cursor_page(
      table.ptr, table.len,
      where.ptr, where.len,
      10n,
      0, 0,
      byField.ptr, byField.len,
    );

    expect(calls[0].sql).toBe('SELECT * FROM items WHERE price > 100 ORDER BY id ASC LIMIT ?');
    expect(calls[0].params).toEqual([11]);
  });

  it('rejects malicious cursor field name', () => {
    const { state, calls } = makeMockState({ results: [] });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const table = writeRaw(memory, 1000, 'items');
    const byField = writeRaw(memory, 1200, 'id; DROP TABLE x; --');

    (bridge as any)._db_cursor_page(
      table.ptr, table.len,
      0, 0,
      10n,
      0, 0,
      byField.ptr, byField.len,
    );

    expect(calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FRAME-DATA-LAST-INSERT-ID-ZERO
//
// MySQL LAST_INSERT_ID() and SQLite LAST_INSERT_ROWID() are session-local.
// The MySQL worker draws each call from a pool, so the SELECT after an
// INSERT hits a different connection and returns 0. The fix moves the
// contract into the bridge: cache the driver-returned insert id on
// WasmState after every successful INSERT/REPLACE, intercept the SELECT,
// and return a synthetic single-row envelope from the cache.
// ─────────────────────────────────────────────────────────────────────────

describe('lastInsertIdAlias', () => {
  it('matches bare MySQL form', () => {
    expect(lastInsertIdAlias('SELECT LAST_INSERT_ID()')).toBe('id');
  });

  it('matches bare SQLite form', () => {
    expect(lastInsertIdAlias('SELECT LAST_INSERT_ROWID()')).toBe('id');
  });

  it('preserves alias casing', () => {
    expect(lastInsertIdAlias('SELECT LAST_INSERT_ID() AS new_id')).toBe('new_id');
    expect(lastInsertIdAlias('SELECT LAST_INSERT_ID() AS NewId')).toBe('NewId');
  });

  it('tolerates whitespace, case, trailing semicolon', () => {
    expect(lastInsertIdAlias('  select   last_insert_id()   as   id  ')).toBe('id');
    expect(lastInsertIdAlias('SELECT LAST_INSERT_ID ( ) AS id')).toBe('id');
    expect(lastInsertIdAlias('SELECT LAST_INSERT_ID() AS id;')).toBe('id');
  });

  it('rejects unrelated queries', () => {
    expect(lastInsertIdAlias('SELECT * FROM t')).toBeNull();
    expect(lastInsertIdAlias('SELECT id FROM t WHERE id = LAST_INSERT_ID()')).toBeNull();
    expect(lastInsertIdAlias('SELECT LAST_INSERT_ID(), other_col FROM t')).toBeNull();
    expect(lastInsertIdAlias('UPDATE t SET x = LAST_INSERT_ID()')).toBeNull();
  });
});

describe('lastInsertIdResponse', () => {
  it('returns a single-row select envelope', () => {
    const body = JSON.parse(lastInsertIdResponse('id', 42));
    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(1);
    expect(body.data.rows).toEqual([{ id: 42 }]);
  });

  it('returns 0 when the cache is empty', () => {
    const body = JSON.parse(lastInsertIdResponse('new_id', null));
    expect(body.data.rows).toEqual([{ new_id: 0 }]);
  });
});

describe('isInsert', () => {
  it('recognizes INSERT and REPLACE, ignoring leading whitespace and case', () => {
    expect(isInsert('INSERT INTO t VALUES (1)')).toBe(true);
    expect(isInsert('  insert  into t values (1)')).toBe(true);
    expect(isInsert('REPLACE INTO t VALUES (1)')).toBe(true);
    expect(isInsert('SELECT * FROM t')).toBe(false);
    expect(isInsert('UPDATE t SET x = 1')).toBe(false);
  });
});

describe('_db_query / _db_execute — LAST_INSERT_ID interception', () => {
  function makeMockExecuteState(opts: {
    executeResult: DbExecuteResult;
  }): { state: WasmState; calls: { sql: string; params: unknown[] }[] } {
    const memory = new WebAssembly.Memory({ initial: 2 });
    let heapPtr = 16384;
    const exports = {
      memory,
      malloc: (size: number): number => {
        const ptr = heapPtr;
        heapPtr += size + 4;
        return ptr;
      },
    } as unknown as WasmState['exports'];

    const calls: { sql: string; params: unknown[] }[] = [];
    const driver: Partial<DatabaseDriver> = {
      querySync(sql: string, params: unknown[]): DbResult {
        calls.push({ sql, params });
        // Mimic the post-INSERT MySQL pool: a fresh connection returns 0.
        return { ok: true, data: { rows: [{ id: 0 }], count: 1 } };
      },
      executeSync(sql: string, params: unknown[]): DbExecuteResult {
        calls.push({ sql, params });
        return opts.executeResult;
      },
    };

    const state: WasmState = {
      exports,
      projectRoot: '/tmp',
      database: driver as DatabaseDriver,
      lastInsertId: null,
      config: { verbose: false } as WasmState['config'],
    } as unknown as WasmState;

    return { state, calls };
  }

  function readReturnedString(memory: WebAssembly.Memory, ptr: number): string {
    // writeLengthPrefixedString lays out [len:u32 LE][UTF-8 bytes]
    const view = new DataView(memory.buffer);
    const len = view.getUint32(ptr, true);
    return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr + 4, len));
  }

  it('caches lastInsertId after a successful INSERT and serves it via SELECT LAST_INSERT_ID()', () => {
    const { state, calls } = makeMockExecuteState({
      executeResult: { count: 1, lastInsertId: 42 },
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const insertSql = writeRaw(memory, 1000, 'INSERT INTO users (name) VALUES (?)');
    const insertParams = writeRaw(memory, 1200, '["alice"]');
    const count = (bridge as any)._db_execute(
      insertSql.ptr, insertSql.len,
      insertParams.ptr, insertParams.len,
    );
    expect(count).toBe(1);
    expect(state.lastInsertId).toBe(42);

    const selectSql = writeRaw(memory, 2000, 'SELECT LAST_INSERT_ID() AS id');
    const retPtr = (bridge as any)._db_query(selectSql.ptr, selectSql.len, 0, 0);
    const body = JSON.parse(readReturnedString(memory, retPtr));
    expect(body.ok).toBe(true);
    expect(body.data.rows).toEqual([{ id: 42 }]);

    // Critical: the driver MUST NOT be queried for LAST_INSERT_ID() — that
    // would dispatch a fresh pooled connection and return 0.
    expect(calls.filter((c) => /LAST_INSERT_ID/i.test(c.sql))).toHaveLength(0);
  });

  it('serves 0 from the cache when no INSERT has happened yet', () => {
    const { state } = makeMockExecuteState({
      executeResult: { count: 0, lastInsertId: null },
    });
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const selectSql = writeRaw(memory, 2000, 'SELECT LAST_INSERT_ROWID()');
    const retPtr = (bridge as any)._db_query(selectSql.ptr, selectSql.len, 0, 0);
    const body = JSON.parse(readReturnedString(memory, retPtr));
    expect(body.data.rows).toEqual([{ id: 0 }]);
  });

  it('does not overwrite lastInsertId on UPDATE/DELETE', () => {
    const { state } = makeMockExecuteState({
      executeResult: { count: 3, lastInsertId: null },
    });
    state.lastInsertId = 99;
    const bridge = createDatabaseBridge(() => state);
    const memory = state.exports.memory!;

    const updateSql = writeRaw(memory, 1000, 'UPDATE users SET name = ? WHERE id = ?');
    const updateParams = writeRaw(memory, 1200, '["bob",1]');
    (bridge as any)._db_execute(
      updateSql.ptr, updateSql.len,
      updateParams.ptr, updateParams.len,
    );
    expect(state.lastInsertId).toBe(99);
  });
});
