import Database from 'better-sqlite3';
import { DatabaseDriver, DbExecuteResult, DbResult } from '../types';
import { formatDbResult, formatDbError } from './index';

function coerceInsertRowId(value: number | bigint | undefined): number | null {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value === 'bigint' && value > 0n) return Number(value);
  return null;
}

/**
 * SQLite database driver using better-sqlite3 (synchronous)
 */
export class SqliteDriver implements DatabaseDriver {
  private db: Database.Database;
  private transactions: Map<string, boolean> = new Map();
  private txCounter = 0;

  constructor(dbPath: string) {
    // Handle :memory: special case
    const path = dbPath === ':memory:' ? ':memory:' : dbPath;
    this.db = new Database(path);

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Enable WAL mode for better concurrency
    if (path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
  }

  /**
   * Execute a query and return results
   */
  async query(sql: string, params: unknown[]): Promise<DbResult> {
    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return formatDbResult(rows);
    } catch (err) {
      return formatDbError(err as Error);
    }
  }

  /**
   * Execute a statement and return affected row count + last_insert_rowid.
   */
  async execute(sql: string, params: unknown[]): Promise<DbExecuteResult> {
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params);
      return {
        count: result.changes,
        lastInsertId: coerceInsertRowId(result.lastInsertRowid),
      };
    } catch (err) {
      console.error('Database execute error:', err);
      return { count: -1, lastInsertId: null };
    }
  }

  /**
   * Begin a transaction
   */
  async beginTransaction(): Promise<string> {
    const txId = `tx_${++this.txCounter}_${Date.now()}`;

    try {
      this.db.exec('BEGIN TRANSACTION');
      this.transactions.set(txId, true);
      return txId;
    } catch (err) {
      throw new Error(`Failed to begin transaction: ${(err as Error).message}`);
    }
  }

  /**
   * Commit a transaction
   */
  async commit(txId: string): Promise<void> {
    if (!this.transactions.has(txId)) {
      throw new Error(`Transaction not found: ${txId}`);
    }

    try {
      this.db.exec('COMMIT');
    } finally {
      this.transactions.delete(txId);
    }
  }

  /**
   * Rollback a transaction
   */
  async rollback(txId: string): Promise<void> {
    if (!this.transactions.has(txId)) {
      throw new Error(`Transaction not found: ${txId}`);
    }

    try {
      this.db.exec('ROLLBACK');
    } finally {
      this.transactions.delete(txId);
    }
  }

  querySync(sql: string, params: unknown[]): DbResult {
    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return formatDbResult(rows);
    } catch (err) {
      return formatDbError(err as Error);
    }
  }

  executeSync(sql: string, params: unknown[]): DbExecuteResult {
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params);
      return {
        count: result.changes,
        lastInsertId: coerceInsertRowId(result.lastInsertRowid),
      };
    } catch (err) {
      console.error('Database execute error:', err);
      return { count: -1, lastInsertId: null };
    }
  }

  beginTransactionSync(): string {
    const txId = `tx_${++this.txCounter}_${Date.now()}`;
    this.db.exec('BEGIN TRANSACTION');
    this.transactions.set(txId, true);
    return txId;
  }

  commitSync(txId: string): void {
    if (!this.transactions.has(txId)) {
      throw new Error(`Transaction not found: ${txId}`);
    }
    try {
      this.db.exec('COMMIT');
    } finally {
      this.transactions.delete(txId);
    }
  }

  rollbackSync(txId: string): void {
    if (!this.transactions.has(txId)) {
      throw new Error(`Transaction not found: ${txId}`);
    }
    try {
      this.db.exec('ROLLBACK');
    } finally {
      this.transactions.delete(txId);
    }
  }

  /**
   * Get last insert rowid
   */
  getLastInsertRowId(): number {
    const stmt = this.db.prepare('SELECT last_insert_rowid() as id');
    const row = stmt.get() as { id: number };
    return row.id;
  }

  /**
   * Close the database
   */
  async close(): Promise<void> {
    // Rollback any pending transactions
    if (this.transactions.size > 0) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore errors during cleanup
      }
      this.transactions.clear();
    }

    this.db.close();
  }
}
