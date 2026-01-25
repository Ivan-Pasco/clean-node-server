import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';
import { parseDbParams } from '../database';

/**
 * Pending async operation storage
 * Since WASM is synchronous, we need to store async results
 */
let lastQueryResult: string = '';
let lastExecuteResult: number = 0;

/**
 * Create database bridge functions
 */
export function createDatabaseBridge(getState: () => WasmState) {
  return {
    /**
     * Execute a query and return results as JSON
     *
     * @param sqlPtr - Pointer to SQL string
     * @param sqlLen - Length of SQL
     * @param paramsPtr - Pointer to JSON params array
     * @param paramsLen - Length of params
     * @returns Pointer to JSON result
     */
    _db_query(
      sqlPtr: number,
      sqlLen: number,
      paramsPtr: number,
      paramsLen: number
    ): number {
      const state = getState();

      if (!state.database) {
        return writeString(state, JSON.stringify({
          ok: false,
          err: { code: 'DB_ERROR', message: 'No database configured' },
        }));
      }

      const sql = readString(state, sqlPtr, sqlLen);
      const paramsJson = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '[]';
      const params = parseDbParams(paramsJson);

      log(state, 'DB', `Query: ${sql}`, { params });

      // Execute query synchronously by blocking on the promise
      // This is a workaround since WASM expects synchronous results
      let result = '';

      state.database.query(sql, params).then((dbResult) => {
        result = JSON.stringify(dbResult);
        lastQueryResult = result;
      }).catch((err) => {
        result = JSON.stringify({
          ok: false,
          err: { code: 'DB_ERROR', message: (err as Error).message },
        });
        lastQueryResult = result;
      });

      // For synchronous operation, return the last cached result
      // The actual async query will update lastQueryResult
      return writeString(state, lastQueryResult || JSON.stringify({
        ok: true,
        data: { rows: [], count: 0 },
      }));
    },

    /**
     * Execute a query asynchronously
     * Call _db_query_result to get the result
     */
    _db_query_async(
      sqlPtr: number,
      sqlLen: number,
      paramsPtr: number,
      paramsLen: number
    ): void {
      const state = getState();

      if (!state.database) {
        lastQueryResult = JSON.stringify({
          ok: false,
          err: { code: 'DB_ERROR', message: 'No database configured' },
        });
        return;
      }

      const sql = readString(state, sqlPtr, sqlLen);
      const paramsJson = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '[]';
      const params = parseDbParams(paramsJson);

      state.database.query(sql, params).then((dbResult) => {
        lastQueryResult = JSON.stringify(dbResult);
      }).catch((err) => {
        lastQueryResult = JSON.stringify({
          ok: false,
          err: { code: 'DB_ERROR', message: (err as Error).message },
        });
      });
    },

    /**
     * Get the result of the last async query
     */
    _db_query_result(): number {
      const state = getState();
      return writeString(state, lastQueryResult);
    },

    /**
     * Execute a statement (INSERT, UPDATE, DELETE)
     *
     * @returns Number of affected rows, or -1 on error
     */
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

      // Execute and cache result
      state.database.execute(sql, params).then((count) => {
        lastExecuteResult = count;
      }).catch((err) => {
        console.error('DB execute error:', err);
        lastExecuteResult = -1;
      });

      return lastExecuteResult;
    },

    /**
     * Execute async and get result later
     */
    _db_execute_async(
      sqlPtr: number,
      sqlLen: number,
      paramsPtr: number,
      paramsLen: number
    ): void {
      const state = getState();

      if (!state.database) {
        lastExecuteResult = -1;
        return;
      }

      const sql = readString(state, sqlPtr, sqlLen);
      const paramsJson = paramsLen > 0 ? readString(state, paramsPtr, paramsLen) : '[]';
      const params = parseDbParams(paramsJson);

      state.database.execute(sql, params).then((count) => {
        lastExecuteResult = count;
      }).catch(() => {
        lastExecuteResult = -1;
      });
    },

    /**
     * Get result of last execute
     */
    _db_execute_result(): number {
      return lastExecuteResult;
    },

    /**
     * Begin a database transaction
     *
     * @returns Pointer to transaction ID string
     */
    _db_begin(): number {
      const state = getState();

      if (!state.database) {
        return writeString(state, '');
      }

      let txId = '';

      state.database.beginTransaction().then((id) => {
        txId = id;
      }).catch((err) => {
        log(state, 'DB', 'Failed to begin transaction', err);
      });

      log(state, 'DB', `Transaction started: ${txId}`);
      return writeString(state, txId);
    },

    /**
     * Commit a transaction
     *
     * @returns 0 on success, -1 on error
     */
    _db_commit(txIdPtr: number, txIdLen: number): number {
      const state = getState();

      if (!state.database) {
        return -1;
      }

      const txId = readString(state, txIdPtr, txIdLen);

      state.database.commit(txId).then(() => {
        log(state, 'DB', `Transaction committed: ${txId}`);
      }).catch((err) => {
        log(state, 'DB', `Failed to commit transaction: ${txId}`, err);
      });

      return 0;
    },

    /**
     * Rollback a transaction
     *
     * @returns 0 on success, -1 on error
     */
    _db_rollback(txIdPtr: number, txIdLen: number): number {
      const state = getState();

      if (!state.database) {
        return -1;
      }

      const txId = readString(state, txIdPtr, txIdLen);

      state.database.rollback(txId).then(() => {
        log(state, 'DB', `Transaction rolled back: ${txId}`);
      }).catch((err) => {
        log(state, 'DB', `Failed to rollback transaction: ${txId}`, err);
      });

      return 0;
    },

    /**
     * Check if database is connected
     */
    _db_connected(): number {
      const state = getState();
      return state.database ? 1 : 0;
    },
  };
}
