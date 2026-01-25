import Database from 'better-sqlite3';
import { DatabaseDriver, DbResult } from '../types';
import { formatDbResult, formatDbError } from './index';

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
   * Execute a statement and return affected row count
   */
  async execute(sql: string, params: unknown[]): Promise<number> {
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params);
      return result.changes;
    } catch (err) {
      console.error('Database execute error:', err);
      return -1;
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
