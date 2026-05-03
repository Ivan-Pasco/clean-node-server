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
  };
}
