import * as path from 'path';
import { Worker } from 'worker_threads';
import { DatabaseDriver, DbResult } from '../types';

const IDLE = 0;
const PENDING = 1;
const CONTROL_BYTES = 8;
const DATA_BUFFER_SIZE = 4 * 1024 * 1024; // 4 MB
const TIMEOUT_MS = 30_000;

export class SyncPostgresDriver implements DatabaseDriver {
  private worker: Worker;
  private ctrl: Int32Array;
  private dataBuf: Uint8Array;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private inFlight = false;

  constructor(connectionString: string, maxConnections?: number) {
    const controlBuffer = new SharedArrayBuffer(CONTROL_BYTES);
    const dataBuffer = new SharedArrayBuffer(DATA_BUFFER_SIZE);

    this.ctrl = new Int32Array(controlBuffer);
    this.dataBuf = new Uint8Array(dataBuffer);

    this.worker = new Worker(path.join(__dirname, 'postgres-worker.js'), {
      workerData: { connectionString, controlBuffer, dataBuffer, maxConnections },
    });

    this.worker.on('error', (err) => {
      console.error('[SyncPostgresDriver] Worker error:', err);
    });
  }

  private sendAndWait(request: object): string {
    if (this.inFlight) {
      throw new Error('SyncPostgresDriver: re-entrant sendAndWait detected');
    }
    this.inFlight = true;
    try {
      const reqBytes = this.encoder.encode(JSON.stringify(request));
      if (reqBytes.length > DATA_BUFFER_SIZE) {
        throw new Error(`Request payload ${reqBytes.length} bytes exceeds buffer ${DATA_BUFFER_SIZE}`);
      }

      this.dataBuf.set(reqBytes);
      Atomics.store(this.ctrl, 1, reqBytes.length);
      Atomics.store(this.ctrl, 0, PENDING);
      this.worker.postMessage(null);

      const outcome = Atomics.wait(this.ctrl, 0, PENDING, TIMEOUT_MS);
      if (outcome === 'timed-out') {
        Atomics.store(this.ctrl, 0, IDLE);
        throw new Error(`PostgreSQL query timed out after ${TIMEOUT_MS}ms`);
      }

      const respLen = Atomics.load(this.ctrl, 1);
      const json = this.decoder.decode(this.dataBuf.slice(0, respLen));
      Atomics.store(this.ctrl, 0, IDLE);
      return json;
    } finally {
      this.inFlight = false;
    }
  }

  // --- Sync methods (used by WASM bridge) ---

  querySync(sql: string, params: unknown[]): DbResult {
    try {
      const envelope = JSON.parse(this.sendAndWait({ op: 'query', sql, params })) as {
        ok: boolean;
        data?: DbResult;
        err?: { code: string; message: string };
      };
      return envelope.ok && envelope.data
        ? envelope.data
        : { ok: false, err: envelope.err ?? { code: 'DB_ERROR', message: 'Unknown error' } };
    } catch (err) {
      return { ok: false, err: { code: 'DB_ERROR', message: (err as Error).message } };
    }
  }

  executeSync(sql: string, params: unknown[]): number {
    try {
      const res = JSON.parse(this.sendAndWait({ op: 'execute', sql, params })) as { ok: boolean; count?: number };
      return res.ok ? (res.count ?? 0) : -1;
    } catch {
      return -1;
    }
  }

  beginTransactionSync(): string {
    const res = JSON.parse(this.sendAndWait({ op: 'begin' })) as { ok: boolean; txId?: string; err?: { message: string } };
    if (!res.ok || !res.txId) {
      throw new Error(res.err?.message ?? 'Failed to begin transaction');
    }
    return res.txId;
  }

  commitSync(txId: string): void {
    const res = JSON.parse(this.sendAndWait({ op: 'commit', txId })) as { ok: boolean; err?: { message: string } };
    if (!res.ok) {
      throw new Error(res.err?.message ?? 'Failed to commit transaction');
    }
  }

  rollbackSync(txId: string): void {
    const res = JSON.parse(this.sendAndWait({ op: 'rollback', txId })) as { ok: boolean; err?: { message: string } };
    if (!res.ok) {
      console.error(`[SyncPostgresDriver] Rollback failed: ${res.err?.message}`);
    }
  }

  // --- Async methods (delegate to sync for a single code path) ---

  async query(sql: string, params: unknown[]): Promise<DbResult> {
    return this.querySync(sql, params);
  }

  async execute(sql: string, params: unknown[]): Promise<number> {
    return this.executeSync(sql, params);
  }

  async beginTransaction(): Promise<string> {
    return this.beginTransactionSync();
  }

  async commit(txId: string): Promise<void> {
    this.commitSync(txId);
  }

  async rollback(txId: string): Promise<void> {
    this.rollbackSync(txId);
  }

  async close(): Promise<void> {
    try {
      this.sendAndWait({ op: 'close' });
    } catch {
      // best-effort
    }
    await this.worker.terminate();
  }
}
