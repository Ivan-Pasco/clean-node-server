import { parentPort } from 'worker_threads';
import { SessionStore, SessionData } from '../types';
import {
  SessionOp,
  SessionOpResult,
  SESSION_IDLE,
  SESSION_PENDING,
  SESSION_TIMEOUT_MS,
} from './broker-types';

/**
 * SessionStore implementation for request workers.
 *
 * Instead of maintaining a local store, each operation is forwarded to the
 * main thread (which owns the canonical InMemorySessionStore) via a dedicated
 * SharedArrayBuffer channel. The worker blocks on Atomics.wait — fine because
 * this runs inside a worker thread, not the main event loop.
 */
export class BrokerSessionStore implements SessionStore {
  private ctrl: Int32Array;
  private dataBuf: Uint8Array;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(controlBuffer: SharedArrayBuffer, dataBuffer: SharedArrayBuffer) {
    this.ctrl = new Int32Array(controlBuffer);
    this.dataBuf = new Uint8Array(dataBuffer);
  }

  private call(op: SessionOp): SessionOpResult {
    const reqBytes = this.encoder.encode(JSON.stringify(op));
    if (reqBytes.length > this.dataBuf.byteLength) {
      throw new Error(`Session op payload too large: ${reqBytes.length} bytes`);
    }

    this.dataBuf.set(reqBytes);
    Atomics.store(this.ctrl, 1, reqBytes.length);
    Atomics.store(this.ctrl, 0, SESSION_PENDING);

    // Signal the main thread to process the op.
    parentPort!.postMessage({ type: 'session_op' });

    // Block this worker thread until the main thread responds.
    // 'not-equal' means the main thread already responded before we waited — that's fine.
    const outcome = Atomics.wait(this.ctrl, 0, SESSION_PENDING, SESSION_TIMEOUT_MS);
    if (outcome === 'timed-out') {
      Atomics.store(this.ctrl, 0, SESSION_IDLE);
      throw new Error('Session broker: main thread did not respond within timeout');
    }

    const respLen = Atomics.load(this.ctrl, 1);
    const json = this.decoder.decode(this.dataBuf.slice(0, respLen));
    Atomics.store(this.ctrl, 0, SESSION_IDLE);
    return JSON.parse(json) as SessionOpResult;
  }

  create(data: Omit<SessionData, 'createdAt' | 'expiresAt'>, ttlSeconds?: number): string {
    return this.call({ op: 'create', data, ttlSeconds }).sessionId!;
  }

  get(sessionId: string): SessionData | undefined {
    return this.call({ op: 'get', sessionId }).session;
  }

  destroy(sessionId: string): boolean {
    return this.call({ op: 'destroy', sessionId }).ok;
  }

  cleanup(): void {
    // Main thread handles periodic cleanup on its own schedule.
  }

  storeValue(sessionId: string, key: string, value: string): boolean {
    return this.call({ op: 'store_value', sessionId, key, value }).ok;
  }

  getValue(sessionId: string, key: string): string | undefined {
    return this.call({ op: 'get_value', sessionId, key }).value;
  }

  deleteValue(sessionId: string, key: string): boolean {
    return this.call({ op: 'delete_value', sessionId, key }).ok;
  }

  hasKey(sessionId: string, key: string): boolean {
    return this.call({ op: 'has_key', sessionId, key }).found ?? false;
  }
}
