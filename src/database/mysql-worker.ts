import { workerData, parentPort } from 'worker_threads';
import mysql, { ExecuteValues } from 'mysql2/promise';

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

const pool = mysql.createPool({
  uri: connectionString,
  connectionLimit: maxConnections ?? 20,
  waitForConnections: true,
  queueLimit: 0,
});

const transactions = new Map<string, mysql.PoolConnection>();

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
  throw new Error('mysql-worker must be run as a worker thread');
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
        const conn = req.txId ? transactions.get(req.txId) : undefined;
        const qparams = (req.params ?? []) as ExecuteValues;
        const [rows] = conn
          ? await conn.query(req.sql!, qparams)
          : await pool.query(req.sql!, qparams);
        const rowArray = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
        writeResponse({ ok: true, data: { ok: true, data: { rows: rowArray, count: rowArray.length } } });
        break;
      }

      case 'execute': {
        const conn = req.txId ? transactions.get(req.txId) : undefined;
        const params = (req.params ?? []) as ExecuteValues;
        const [result] = conn
          ? await conn.execute(req.sql!, params)
          : await pool.execute(req.sql!, params);
        const affectedRows = (result as mysql.ResultSetHeader).affectedRows ?? 0;
        writeResponse({ ok: true, count: affectedRows });
        break;
      }

      case 'begin': {
        const conn = await pool.getConnection();
        await conn.beginTransaction();
        const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        transactions.set(txId, conn);
        writeResponse({ ok: true, txId });
        break;
      }

      case 'commit': {
        const conn = transactions.get(req.txId!);
        if (!conn) {
          writeResponse({ ok: false, err: { code: 'TX_NOT_FOUND', message: `Transaction not found: ${req.txId}` } });
          break;
        }
        try {
          await conn.commit();
        } finally {
          conn.release();
          transactions.delete(req.txId!);
        }
        writeResponse({ ok: true });
        break;
      }

      case 'rollback': {
        const conn = transactions.get(req.txId!);
        if (!conn) {
          writeResponse({ ok: false, err: { code: 'TX_NOT_FOUND', message: `Transaction not found: ${req.txId}` } });
          break;
        }
        try {
          await conn.rollback();
        } finally {
          conn.release();
          transactions.delete(req.txId!);
        }
        writeResponse({ ok: true });
        break;
      }

      case 'close': {
        for (const [, conn] of transactions.entries()) {
          try { await conn.rollback(); } catch { /* ignore */ }
          conn.release();
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
