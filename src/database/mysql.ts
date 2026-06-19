import * as path from 'path';
import { Worker } from 'worker_threads';
import { DatabaseDriver, DbExecuteResult, DbResult } from '../types';

const IDLE = 0;
const PENDING = 1;
// ctrl layout (4 × i32):
//   ctrl[0] = state, ctrl[1] = len, ctrl[2] = request seq, ctrl[3] = response seq
const CONTROL_BYTES = 16;
const DATA_BUFFER_SIZE = 4 * 1024 * 1024; // 4 MB
const TIMEOUT_MS = 30_000;

export class SyncMysqlDriver implements DatabaseDriver {
  private worker: Worker;
  private ctrl: Int32Array;
  private dataBuf: Uint8Array;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private inFlight = false;
  // RUNTIME-DB-POOL-WEDGE: monotonically increasing per-request seq so the
  // worker can detect when its response is stale (main thread timed out and
  // moved on) and silently discard it instead of corrupting the next call's
  // payload buffer.
  private seq = 0;

  constructor(connectionString: string, maxConnections?: number) {
    const controlBuffer = new SharedArrayBuffer(CONTROL_BYTES);
    const dataBuffer = new SharedArrayBuffer(DATA_BUFFER_SIZE);

    this.ctrl = new Int32Array(controlBuffer);
    this.dataBuf = new Uint8Array(dataBuffer);

    this.worker = new Worker(path.join(__dirname, 'mysql-worker.js'), {
      workerData: { connectionString, controlBuffer, dataBuffer, maxConnections },
    });

    this.worker.on('error', (err) => {
      console.error('[SyncMysqlDriver] Worker error:', err);
    });
  }

  private sendAndWait(request: object): string {
    if (this.inFlight) {
      throw new Error('SyncMysqlDriver: re-entrant sendAndWait detected');
    }
    this.inFlight = true;
    try {
      const reqBytes = this.encoder.encode(JSON.stringify(request));
      if (reqBytes.length > DATA_BUFFER_SIZE) {
        throw new Error(`Request payload ${reqBytes.length} bytes exceeds buffer ${DATA_BUFFER_SIZE}`);
      }

      const mySeq = ++this.seq;
      // Write seq BEFORE the worker can observe PENDING: the worker reads
      // ctrl[2] at handler entry and uses it to drop stale responses.
      Atomics.store(this.ctrl, 2, mySeq);
      this.dataBuf.set(reqBytes);
      Atomics.store(this.ctrl, 1, reqBytes.length);
      Atomics.store(this.ctrl, 0, PENDING);
      this.worker.postMessage(null);

      const outcome = Atomics.wait(this.ctrl, 0, PENDING, TIMEOUT_MS);
      if (outcome === 'timed-out') {
        // Bump seq so the wedged worker's eventual writeResponse is dropped
        // (it'll see ctrl[2] has moved past its captured seq).
        Atomics.store(this.ctrl, 2, ++this.seq);
        Atomics.store(this.ctrl, 0, IDLE);
        throw new Error(`MySQL query timed out after ${TIMEOUT_MS}ms`);
      }

      const respSeq = Atomics.load(this.ctrl, 3);
      if (respSeq !== mySeq) {
        // Defensive: a previous stale handler wrote DONE under us. Treat as
        // missing response. The worker's seq guard should prevent this, but
        // surface it cleanly if it ever fires instead of returning garbage.
        Atomics.store(this.ctrl, 0, IDLE);
        throw new Error(`MySQL worker returned stale response (seq ${respSeq}, expected ${mySeq})`);
      }
      const respLen = Atomics.load(this.ctrl, 1);
      const json = this.decoder.decode(this.dataBuf.slice(0, respLen));
      Atomics.store(this.ctrl, 0, IDLE);
      return json;
    } finally {
      this.inFlight = false;
    }
  }

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

  executeSync(sql: string, params: unknown[]): DbExecuteResult {
    try {
      const res = JSON.parse(this.sendAndWait({ op: 'execute', sql, params })) as {
        ok: boolean;
        count?: number;
        insertId?: number | null;
      };
      if (!res.ok) {
        return { count: -1, lastInsertId: null };
      }
      return {
        count: res.count ?? 0,
        lastInsertId: typeof res.insertId === 'number' && res.insertId > 0 ? res.insertId : null,
      };
    } catch {
      return { count: -1, lastInsertId: null };
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
      console.error(`[SyncMysqlDriver] Rollback failed: ${res.err?.message}`);
    }
  }

  async query(sql: string, params: unknown[]): Promise<DbResult> {
    return this.querySync(sql, params);
  }

  async execute(sql: string, params: unknown[]): Promise<DbExecuteResult> {
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
