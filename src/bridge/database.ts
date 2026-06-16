import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';
import { parseDbParams } from '../database';

/**
 * Per-state async result cache for drivers that don't support sync execution (e.g. PostgreSQL).
 * Keyed on the WasmState object to avoid cross-request contamination.
 */
const asyncCache = new WeakMap<WasmState, { lastQueryResult: string; lastExecuteResult: number }>();

function getAsyncCache(state: WasmState): { lastQueryResult: string; lastExecuteResult: number } {
  let cache = asyncCache.get(state);
  if (!cache) {
    cache = { lastQueryResult: '', lastExecuteResult: 0 };
    asyncCache.set(state, cache);
  }
  return cache;
}

const NO_DB_RESULT = JSON.stringify({
  ok: false,
  err: { code: 'DB_ERROR', message: 'No database configured' },
});

const EMPTY_QUERY_RESULT = JSON.stringify({ ok: true, data: { rows: [], count: 0 } });

/**
 * Create database bridge functions
 */
export function createDatabaseBridge(getState: () => WasmState) {
  return {
    _db_query(
      sqlPtr: number,
      sqlLen: number,
      paramsPtr: number,
      paramsLen: number
    ): number {
      const state = getState();

      if (!state.database) {
        return writeString(state, NO_DB_RESULT);
      }

      const sql = readString(state, sqlPtr, sqlLen);
      const paramsJson = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '[]';
      const params = parseDbParams(paramsJson);

      log(state, 'DB', `Query: ${sql}`, { params });

      if (state.database.querySync) {
        const result = state.database.querySync(sql, params);
        return writeString(state, JSON.stringify(result));
      }

      // PostgreSQL fallback: fire-and-update cache; result is available on next call
      const cache = getAsyncCache(state);
      state.database.query(sql, params).then((dbResult) => {
        cache.lastQueryResult = JSON.stringify(dbResult);
      }).catch((err) => {
        cache.lastQueryResult = JSON.stringify({
          ok: false,
          err: { code: 'DB_ERROR', message: (err as Error).message },
        });
      });

      return writeString(state, cache.lastQueryResult || EMPTY_QUERY_RESULT);
    },

    _db_query_async(
      sqlPtr: number,
      sqlLen: number,
      paramsPtr: number,
      paramsLen: number
    ): void {
      const state = getState();

      if (!state.database) {
        getAsyncCache(state).lastQueryResult = NO_DB_RESULT;
        return;
      }

      const sql = readString(state, sqlPtr, sqlLen);
      const paramsJson = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '[]';
      const params = parseDbParams(paramsJson);
      const cache = getAsyncCache(state);

      state.database.query(sql, params).then((dbResult) => {
        cache.lastQueryResult = JSON.stringify(dbResult);
      }).catch((err) => {
        cache.lastQueryResult = JSON.stringify({
          ok: false,
          err: { code: 'DB_ERROR', message: (err as Error).message },
        });
      });
    },

    _db_query_result(): number {
      const state = getState();
      return writeString(state, getAsyncCache(state).lastQueryResult);
    },

    _db_execute(
      sqlPtr: number,
      sqlLen: number,
      paramsPtr: number,
      paramsLen: number
    ): number {
      const state = getState();

      if (!state.database) {
        return -1;
      }

      const sql = readString(state, sqlPtr, sqlLen);
      const paramsJson = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '[]';
      const params = parseDbParams(paramsJson);

      log(state, 'DB', `Execute: ${sql}`, { params });

      if (state.database.executeSync) {
        return state.database.executeSync(sql, params);
      }

      // PostgreSQL fallback
      const cache = getAsyncCache(state);
      state.database.execute(sql, params).then((count) => {
        cache.lastExecuteResult = count;
      }).catch((err) => {
        console.error('DB execute error:', err);
        cache.lastExecuteResult = -1;
      });

      return cache.lastExecuteResult;
    },

    _db_execute_async(
      sqlPtr: number,
      sqlLen: number,
      paramsPtr: number,
      paramsLen: number
    ): void {
      const state = getState();

      if (!state.database) {
        getAsyncCache(state).lastExecuteResult = -1;
        return;
      }

      const sql = readString(state, sqlPtr, sqlLen);
      const paramsJson = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '[]';
      const params = parseDbParams(paramsJson);
      const cache = getAsyncCache(state);

      state.database.execute(sql, params).then((count) => {
        cache.lastExecuteResult = count;
      }).catch(() => {
        cache.lastExecuteResult = -1;
      });
    },

    _db_execute_result(): number {
      return getAsyncCache(getState()).lastExecuteResult;
    },

    _db_begin(): number {
      const state = getState();

      if (!state.database) {
        return writeString(state, '');
      }

      if (state.database.beginTransactionSync) {
        try {
          const txId = state.database.beginTransactionSync();
          log(state, 'DB', `Transaction started: ${txId}`);
          return writeString(state, txId);
        } catch (err) {
          log(state, 'DB', 'Failed to begin transaction', err);
          return writeString(state, '');
        }
      }

      // PostgreSQL fallback — fires async, txId returned on next _db_query call
      let txId = '';
      state.database.beginTransaction().then((id) => {
        txId = id;
        log(state, 'DB', `Transaction started async: ${id}`);
      }).catch((err) => {
        log(state, 'DB', 'Failed to begin transaction', err);
      });

      return writeString(state, txId);
    },

    _db_commit(txIdPtr: number, txIdLen: number): number {
      const state = getState();

      if (!state.database) {
        return -1;
      }

      const txId = readString(state, txIdPtr, txIdLen);

      if (state.database.commitSync) {
        try {
          state.database.commitSync(txId);
          log(state, 'DB', `Transaction committed: ${txId}`);
          return 0;
        } catch (err) {
          log(state, 'DB', `Failed to commit transaction: ${txId}`, err);
          return -1;
        }
      }

      state.database.commit(txId).then(() => {
        log(state, 'DB', `Transaction committed: ${txId}`);
      }).catch((err) => {
        log(state, 'DB', `Failed to commit transaction: ${txId}`, err);
      });

      return 0;
    },

    _db_rollback(txIdPtr: number, txIdLen: number): number {
      const state = getState();

      if (!state.database) {
        return -1;
      }

      const txId = readString(state, txIdPtr, txIdLen);

      if (state.database.rollbackSync) {
        try {
          state.database.rollbackSync(txId);
          log(state, 'DB', `Transaction rolled back: ${txId}`);
          return 0;
        } catch (err) {
          log(state, 'DB', `Failed to rollback transaction: ${txId}`, err);
          return -1;
        }
      }

      state.database.rollback(txId).then(() => {
        log(state, 'DB', `Transaction rolled back: ${txId}`);
      }).catch((err) => {
        log(state, 'DB', `Failed to rollback transaction: ${txId}`, err);
      });

      return 0;
    },

    _db_connected(): number {
      const state = getState();
      return state.database ? 1 : 0;
    },

    // ── Pagination & field validation ──────────────────────────────────
    // clean-server delegates these to a `db_bridge.call("paginate" | ...)`
    // abstraction that doesn't exist in node-server. We do the SQL building
    // here directly, using the same per-driver querySync path as _db_query.
    //
    // WHERE format: a flat JSON object {col: value, ...} produces
    //   `WHERE col1 = ? AND col2 = ?` with bound params, applied for both
    //   items and count queries. Each column name is validated against a
    //   strict identifier regex to prevent SQL injection — the value side
    //   is always parameterized so it doesn't need that check.

    _db_paginate(
      tablePtr: number, tableLen: number,
      wherePtr: number, whereLen: number,
      page: bigint, perPage: bigint,
    ): number {
      const state = getState();
      if (!state.database?.querySync) {
        return writeString(state, NO_DB_RESULT);
      }

      const table = readString(state, tablePtr, tableLen);
      const whereJson = whereLen > 0
        ? readString(state, wherePtr, whereLen)
        : '{}';

      if (!isSafeIdentifier(table)) {
        return writeString(state, JSON.stringify({
          ok: false,
          err: { code: 'BAD_TABLE', message: `Invalid table name: ${table}` },
        }));
      }

      const { clause, params: whereParams, orderBy, error: whereError } =
        buildWhereClause(whereJson);
      if (whereError) {
        return writeString(state, JSON.stringify({
          ok: false,
          err: { code: 'BAD_WHERE', message: whereError },
        }));
      }

      const safePerPage = Math.max(1, Math.min(Number(perPage), 1000));
      const safePage = Math.max(1, Number(page));
      const offset = (safePage - 1) * safePerPage;

      const orderSql = orderBy ? ` ORDER BY ${orderBy}` : '';
      const itemsSql = `SELECT * FROM ${table} ${clause}${orderSql} LIMIT ? OFFSET ?`;
      const itemsResult = state.database.querySync(itemsSql, [
        ...whereParams,
        safePerPage,
        offset,
      ]);
      if (!itemsResult.ok) {
        return writeString(state, JSON.stringify(itemsResult));
      }

      const countSql = `SELECT COUNT(*) AS total FROM ${table} ${clause}`;
      const countResult = state.database.querySync(countSql, whereParams);
      const total = extractCount(countResult);
      const totalPages = total === 0 ? 0 : Math.ceil(total / safePerPage);

      return writeString(state, JSON.stringify({
        ok: true,
        data: {
          items: itemsResult.data?.rows ?? [],
          page: safePage,
          per_page: safePerPage,
          total,
          total_pages: totalPages,
        },
      }));
    },

    _db_cursor_page(
      tablePtr: number, tableLen: number,
      wherePtr: number, whereLen: number,
      perPage: bigint,
      afterPtr: number, afterLen: number,
      byFieldPtr: number, byFieldLen: number,
    ): number {
      const state = getState();
      if (!state.database?.querySync) {
        return writeString(state, NO_DB_RESULT);
      }

      const table = readString(state, tablePtr, tableLen);
      const whereJson = whereLen > 0
        ? readString(state, wherePtr, whereLen)
        : '{}';
      const after = afterLen > 0 ? readString(state, afterPtr, afterLen) : '';
      const byField = readString(state, byFieldPtr, byFieldLen);

      if (!isSafeIdentifier(table)) {
        return writeString(state, JSON.stringify({
          ok: false,
          err: { code: 'BAD_TABLE', message: `Invalid table name: ${table}` },
        }));
      }
      if (!isSafeIdentifier(byField)) {
        return writeString(state, JSON.stringify({
          ok: false,
          err: { code: 'BAD_CURSOR_FIELD', message: `Invalid cursor field: ${byField}` },
        }));
      }

      const { clause, params: whereParams, error: whereError } =
        buildWhereClause(whereJson);
      if (whereError) {
        return writeString(state, JSON.stringify({
          ok: false,
          err: { code: 'BAD_WHERE', message: whereError },
        }));
      }

      // Cursor predicate: `byField > after` if cursor is non-empty.
      // Fetch one extra row to detect "has more".
      const safePerPage = Math.max(1, Math.min(Number(perPage), 1000));
      const cursorClause = after !== ''
        ? (clause === '' ? `WHERE ${byField} > ?` : `${clause} AND ${byField} > ?`)
        : clause;
      const queryParams = after !== ''
        ? [...whereParams, after]
        : whereParams;

      const sql = `SELECT * FROM ${table} ${cursorClause} ORDER BY ${byField} ASC LIMIT ?`;
      const result = state.database.querySync(sql, [...queryParams, safePerPage + 1]);
      if (!result.ok) {
        return writeString(state, JSON.stringify(result));
      }

      const rows = (result.data?.rows ?? []) as Record<string, unknown>[];
      const hasMore = rows.length > safePerPage;
      const items = hasMore ? rows.slice(0, safePerPage) : rows;
      const nextCursor = hasMore && items.length > 0
        ? String(items[items.length - 1]![byField] ?? '')
        : '';

      return writeString(state, JSON.stringify({
        ok: true,
        data: {
          items,
          per_page: safePerPage,
          next_cursor: nextCursor,
          has_more: hasMore,
        },
      }));
    },

    _db_valid_field(
      tablePtr: number, tableLen: number,
      fieldPtr: number, fieldLen: number,
    ): number {
      const state = getState();
      const table = readString(state, tablePtr, tableLen);
      const field = readString(state, fieldPtr, fieldLen);

      // Identifier safety must hold even without a database — this is the
      // anti-injection guarantee callers depend on for ORDER BY.
      if (!isSafeIdentifier(table) || !isSafeIdentifier(field)) {
        return 0;
      }

      // No database → identifier check alone is what we can offer.
      if (!state.database?.querySync) {
        return 1;
      }

      // Confirm the field actually exists on the table by selecting it with
      // a 0-row limit. Portable across SQLite / MySQL / PostgreSQL.
      try {
        const result = state.database.querySync(
          `SELECT ${field} FROM ${table} LIMIT 0`,
          [],
        );
        return result.ok ? 1 : 0;
      } catch {
        return 0;
      }
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// ORDER BY accepts `<col>[ ASC|DESC](, <col>[ ASC|DESC])*`. Restricting the
// charset to word chars / spaces / commas blocks `;`, `--`, quotes, parens.
const SAFE_ORDER_BY = /^[A-Za-z_][\w\s,]*$/;

const RESERVED_WHERE_KEY = '__where';
const RESERVED_ORDER_KEY = '__order';

function isSafeIdentifier(s: string): boolean {
  return SAFE_IDENTIFIER.test(s);
}

interface WhereResult {
  clause: string;
  params: unknown[];
  orderBy?: string;
  error?: string;
}

// Reserved-key bridge protocol (DB-BUILD-WHERE-IGNORES-DUNDER-WHERE):
// the framework's frame.data plugin emits `__where` and `__order` envelopes for
// operators it cannot express as column = value (e.g. `IS NOT NULL`, `> NOW()`,
// `created_at DESC`). Their values are raw SQL fragments produced by the
// plugin's codegen and must pass through verbatim — not bind as parameters.
function buildWhereClause(whereJson: string): WhereResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(whereJson);
  } catch {
    return { clause: '', params: [], error: 'WHERE clause is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { clause: '', params: [] };
  }

  const filters = parsed as Record<string, unknown>;
  const clauses: string[] = [];
  const params: unknown[] = [];
  let orderBy: string | undefined;

  for (const [key, val] of Object.entries(filters)) {
    if (key === RESERVED_WHERE_KEY) {
      if (typeof val !== 'string' || val.length === 0) continue;
      clauses.push(val);
      continue;
    }
    if (key === RESERVED_ORDER_KEY) {
      if (typeof val !== 'string' || val.length === 0) continue;
      if (!SAFE_ORDER_BY.test(val)) {
        return { clause: '', params: [], error: `Invalid ORDER BY: ${val}` };
      }
      orderBy = val;
      continue;
    }
    if (!isSafeIdentifier(key)) {
      return { clause: '', params: [], error: `Invalid column in WHERE: ${key}` };
    }
    clauses.push(`${key} = ?`);
    params.push(val);
  }

  const clause = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  return { clause, params, orderBy };
}

function extractCount(result: import('../types').DbResult): number {
  if (!result.ok) return 0;
  const rows = result.data?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const first = rows[0] as Record<string, unknown>;
  // Drivers vary in alias casing; check both.
  const v = first.total ?? first.TOTAL ?? Object.values(first)[0];
  return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number(v ?? 0);
}
