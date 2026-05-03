import { AnySessionStore } from '../types';
import {
  SessionOp,
  SessionOpResult,
  SESSION_DONE,
} from './broker-types';

/**
 * Handles session IPC for one worker thread.
 *
 * When a worker sends { type: 'session_op' }, the RequestWorkerPool calls
 * handleOp() on this object. It reads the request from the shared buffer,
 * executes it against the canonical (main-thread) session store, writes the
 * result back, and notifies the waiting worker.
 *
 * handleOp() is async so it works transparently with both the synchronous
 * InMemorySessionStore and the async RedisSessionStore. The worker is already
 * blocked on Atomics.wait, so the main event loop is free to process the
 * async I/O before notifying the worker.
 */
export class SessionChannelHandler {
  private ctrl: Int32Array;
  private dataBuf: Uint8Array;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(
    controlBuffer: SharedArrayBuffer,
    dataBuffer: SharedArrayBuffer,
    private sessionStore: AnySessionStore
  ) {
    this.ctrl = new Int32Array(controlBuffer);
    this.dataBuf = new Uint8Array(dataBuffer);
  }

  async handleOp(): Promise<void> {
    const reqLen = Atomics.load(this.ctrl, 1);
    const json = this.decoder.decode(this.dataBuf.slice(0, reqLen));
    const op = JSON.parse(json) as SessionOp;
    const result = await this.processOp(op);

    const respBytes = this.encoder.encode(JSON.stringify(result));
    this.dataBuf.set(respBytes);
    Atomics.store(this.ctrl, 1, respBytes.length);
    Atomics.store(this.ctrl, 0, SESSION_DONE);
    Atomics.notify(this.ctrl, 0, 1);
  }

  private async processOp(op: SessionOp): Promise<SessionOpResult> {
    switch (op.op) {
      case 'create':
        return { ok: true, sessionId: await this.sessionStore.create(op.data, op.ttlSeconds) };

      case 'get':
        return { ok: true, session: await this.sessionStore.get(op.sessionId) };

      case 'destroy':
        return { ok: await this.sessionStore.destroy(op.sessionId) };

      case 'cleanup':
        await this.sessionStore.cleanup();
        return { ok: true };

      case 'store_value':
        return { ok: (await this.sessionStore.storeValue?.(op.sessionId, op.key, op.value)) ?? false };

      case 'get_value':
        return { ok: true, value: await this.sessionStore.getValue?.(op.sessionId, op.key) };

      case 'delete_value':
        return { ok: (await this.sessionStore.deleteValue?.(op.sessionId, op.key)) ?? false };

      case 'has_key':
        return { ok: true, found: (await this.sessionStore.hasKey?.(op.sessionId, op.key)) ?? false };

      default:
        return { ok: false };
    }
  }
}
