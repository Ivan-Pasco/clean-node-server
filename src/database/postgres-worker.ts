import { workerData, parentPort } from 'worker_threads';
import { Pool, PoolClient } from 'pg';

const IDLE = 0;
const DONE = 2;

interface WorkerInit {
  connectionString: string;
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
  maxConnections?: number;
}

const { connectionString, controlBuffer, dataBuffer, maxConnections } = workerData as WorkerInit;

const ctrl = new Int32Array(controlBuffer);
const dataBuf = new Uint8Array(dataBuffer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const pool = new Pool({
  connectionString,
  max: maxConnections ?? 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const transactions = new Map<string, PoolClient>();

function writeResponse(response: unknown): void {
  const json = JSON.stringify(response);
  const bytes = encoder.encode(json);

  if (bytes.length > dataBuffer.byteLength) {
    const errBytes = encoder.encode(JSON.stringify({
      ok: false,
      err: { code: 'BUFFER_OVERFLOW', message: `Response ${bytes.length} bytes exceeds buffer ${dataBuffer.byteLength}` },
    }));
    dataBuf.set(errBytes);
    Atomics.store(ctrl, 1, errBytes.length);
  } else {
    dataBuf.set(bytes);
    Atomics.store(ctrl, 1, bytes.length);
  }

  Atomics.store(ctrl, 0, DONE);
  Atomics.notify(ctrl, 0, 1);
}

if (!parentPort) {
  throw new Error('postgres-worker must be run as a worker thread');
}

parentPort.on('message', async () => {
  try {
    const reqLen = Atomics.load(ctrl, 1);
    const req = JSON.parse(decoder.decode(dataBuf.slice(0, reqLen))) as {
      op: string;
      sql?: string;
      params?: unknown[];
      txId?: string;
    };

    switch (req.op) {
      case 'query': {
        const client = req.txId ? transactions.get(req.txId) : undefined;
        const result = client
          ? await client.query(req.sql!, req.params as unknown[] ?? [])
          : await pool.query(req.sql!, req.params as unknown[] ?? []);
        writeResponse({ ok: true, data: { ok: true, data: { rows: result.rows, count: result.rows.length } } });
        break;
      }

      case 'execute': {
        const client = req.txId ? transactions.get(req.txId) : undefined;
        const result = client
          ? await client.query(req.sql!, req.params as unknown[] ?? [])
          : await pool.query(req.sql!, req.params as unknown[] ?? []);
        writeResponse({ ok: true, count: result.rowCount ?? 0 });
        break;
      }

      case 'begin': {
        const client = await pool.connect();
        await client.query('BEGIN');
        const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        transactions.set(txId, client);
        writeResponse({ ok: true, txId });
        break;
      }

      case 'commit': {
        const client = transactions.get(req.txId!);
        if (!client) {
          writeResponse({ ok: false, err: { code: 'TX_NOT_FOUND', message: `Transaction not found: ${req.txId}` } });
          break;
        }
        try {
          await client.query('COMMIT');
        } finally {
          client.release();
          transactions.delete(req.txId!);
        }
        writeResponse({ ok: true });
        break;
      }

      case 'rollback': {
        const client = transactions.get(req.txId!);
        if (!client) {
          writeResponse({ ok: false, err: { code: 'TX_NOT_FOUND', message: `Transaction not found: ${req.txId}` } });
          break;
        }
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
          transactions.delete(req.txId!);
        }
        writeResponse({ ok: true });
        break;
      }

      case 'close': {
        for (const [, client] of transactions.entries()) {
          try { await client.query('ROLLBACK'); } catch { /* ignore */ }
          client.release();
        }
        transactions.clear();
        await pool.end();
        writeResponse({ ok: true });
        break;
      }

      default:
        writeResponse({ ok: false, err: { code: 'UNKNOWN_OP', message: `Unknown operation: ${req.op}` } });
    }
  } catch (err) {
    writeResponse({ ok: false, err: { code: 'DB_ERROR', message: (err as Error).message } });
  }
});
