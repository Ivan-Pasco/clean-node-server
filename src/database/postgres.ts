import { Pool, PoolClient } from 'pg';
import { DatabaseDriver, DbResult } from '../types';
import { formatDbResult, formatDbError } from './index';

/**
 * PostgreSQL database driver using pg Pool
 */
export class PostgresDriver implements DatabaseDriver {
  private pool: Pool;
  private transactions: Map<string, PoolClient> = new Map();
  private txCounter = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }

  /**
   * Execute a query and return results
   */
  async query(sql: string, params: unknown[]): Promise<DbResult> {
    try {
      const result = await this.pool.query(sql, params);
      return formatDbResult(result.rows);
    } catch (err) {
      return formatDbError(err as Error);
    }
  }

  /**
   * Execute a statement and return affected row count
   */
  async execute(sql: string, params: unknown[]): Promise<number> {
    try {
      const result = await this.pool.query(sql, params);
      return result.rowCount ?? 0;
    } catch (err) {
      console.error('Database execute error:', err);
      return -1;
    }
  }

  /**
   * Begin a transaction
   */
  async beginTransaction(): Promise<string> {
    const client = await this.pool.connect();
    await client.query('BEGIN');

    const txId = `tx_${++this.txCounter}_${Date.now()}`;
    this.transactions.set(txId, client);

    return txId;
  }

  /**
   * Commit a transaction
   */
  async commit(txId: string): Promise<void> {
    const client = this.transactions.get(txId);

    if (!client) {
      throw new Error(`Transaction not found: ${txId}`);
    }

    try {
      await client.query('COMMIT');
    } finally {
      client.release();
      this.transactions.delete(txId);
    }
  }

  /**
   * Rollback a transaction
   */
  async rollback(txId: string): Promise<void> {
    const client = this.transactions.get(txId);

    if (!client) {
      throw new Error(`Transaction not found: ${txId}`);
    }

    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
      this.transactions.delete(txId);
    }
  }

  /**
   * Execute a query within a transaction
   */
  async queryInTransaction(
    txId: string,
    sql: string,
    params: unknown[]
  ): Promise<DbResult> {
    const client = this.transactions.get(txId);

    if (!client) {
      return formatDbError(new Error(`Transaction not found: ${txId}`));
    }

    try {
      const result = await client.query(sql, params);
      return formatDbResult(result.rows);
    } catch (err) {
      return formatDbError(err as Error);
    }
  }

  /**
   * Execute a statement within a transaction
   */
  async executeInTransaction(
    txId: string,
    sql: string,
    params: unknown[]
  ): Promise<number> {
    const client = this.transactions.get(txId);

    if (!client) {
      console.error(`Transaction not found: ${txId}`);
      return -1;
    }

    try {
      const result = await client.query(sql, params);
      return result.rowCount ?? 0;
    } catch (err) {
      console.error('Database execute error:', err);
      return -1;
    }
  }

  /**
   * Close the pool
   */
  async close(): Promise<void> {
    // Rollback any pending transactions
    for (const [txId, client] of this.transactions.entries()) {
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch {
        // Ignore errors during cleanup
      }
      this.transactions.delete(txId);
    }

    await this.pool.end();
  }
}
