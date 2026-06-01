import { workerData, parentPort } from 'worker_threads';
import * as readline from 'readline';

interface WorkerInit {
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
}

const { controlBuffer, dataBuffer } = workerData as WorkerInit;
const ctrl = new Int32Array(controlBuffer);
const dataBuf = new Uint8Array(dataBuffer);
const encoder = new TextEncoder();

const IDLE = 0;
const READY = 1;
const CLOSED = 2;

const queue: string[] = [];
let wasmWaiting = false;

function signalLine(line: string): void {
  const bytes = encoder.encode(line);
  const len = Math.min(bytes.length, dataBuf.byteLength);
  dataBuf.set(bytes.subarray(0, len));
  Atomics.store(ctrl, 1, len);
  Atomics.store(ctrl, 0, READY);
  Atomics.notify(ctrl, 0, 1);
  wasmWaiting = false;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line: string) => {
  if (wasmWaiting) {
    signalLine(line);
  } else {
    queue.push(line);
  }
});

rl.on('close', () => {
  if (wasmWaiting) {
    Atomics.store(ctrl, 0, CLOSED);
    Atomics.notify(ctrl, 0, 1);
  }
});

if (!parentPort) {
  throw new Error('mcp-stdio-worker must be run as a worker thread');
}

parentPort.on('message', () => {
  if (queue.length > 0) {
    signalLine(queue.shift()!);
  } else {
    wasmWaiting = true;
  }
});

// Suppress unused variable warnings for constants used only in type-level positions.
void IDLE;
void READY;
