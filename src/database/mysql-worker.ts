import { workerData, parentPort } from 'worker_threads';
import mysql from 'mysql2/promise';
import {
  handleRequest,
  WorkerRequest,
  WorkerResponse,
  ConnLike,
} from './mysql-worker-impl';

const DONE = 2;

interface WorkerInit {
  connectionString: string;
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
  maxConnections?: number;
}

const { connectionString, controlBuffer, dataBuffer, maxConnections } = workerData as WorkerInit;

// ctrl layout (4 × i32):
//   ctrl[0] = state (IDLE/PENDING/DONE)
//   ctrl[1] = payload length
//   ctrl[2] = current request seq (main thread writes before posting)
//   ctrl[3] = response seq (worker writes when sending response)
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

const transactions = new Map<string, ConnLike>();

function workerLog(level: 'warn' | 'error' | 'info', msg: string, extra?: Record<string, unknown>): void {
  const payload = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  if (level === 'error') {
    console.error(`[mysql-worker] ${payload}`);
  } else if (level === 'warn') {
    console.warn(`[mysql-worker] ${payload}`);
  } else {
    console.info(`[mysql-worker] ${payload}`);
  }
}

function writeResponse(response: WorkerResponse, capturedSeq: number): void {
  // RUNTIME-DB-POOL-WEDGE: when the main thread times out a sendAndWait it
  // bumps the seq forward. If we are about to respond for an older seq, the
  // main thread has already moved on — writing into dataBuf would clobber the
  // next request's payload. Drop the response silently.
  if (Atomics.load(ctrl, 2) !== capturedSeq) {
    return;
  }

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

  Atomics.store(ctrl, 3, capturedSeq);
  Atomics.store(ctrl, 0, DONE);
  Atomics.notify(ctrl, 0, 1);
}

if (!parentPort) {
  throw new Error('mysql-worker must be run as a worker thread');
}

parentPort.on('message', async () => {
  // Capture the seq the main thread set for this request. If we get preempted
  // (the main thread times out and posts a new request before we respond), the
  // seq guard in writeResponse will silently drop our stale response.
  const capturedSeq = Atomics.load(ctrl, 2);
  let req: WorkerRequest;
  try {
    const reqLen = Atomics.load(ctrl, 1);
    req = JSON.parse(decoder.decode(dataBuf.slice(0, reqLen))) as WorkerRequest;
  } catch (err) {
    writeResponse({ ok: false, err: { code: 'BAD_REQUEST', message: (err as Error).message } }, capturedSeq);
    return;
  }

  try {
    const response = await handleRequest(req, {
      pool: pool as unknown as Parameters<typeof handleRequest>[1]['pool'],
      transactions,
      log: workerLog,
    });
    writeResponse(response, capturedSeq);
  } catch (err) {
    // handleRequest catches its own errors, but guard the message-handler
    // boundary so a thrown error never deadlocks the main thread waiting on
    // Atomics.wait.
    writeResponse({ ok: false, err: { code: 'DB_ERROR', message: (err as Error).message } }, capturedSeq);
  }
});
