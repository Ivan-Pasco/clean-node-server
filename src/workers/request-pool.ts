import * as path from 'path';
import { Worker } from 'worker_threads';
import { RequestContext, AnySessionStore } from '../types';
import { SessionChannelHandler } from '../session/session-channel';
import { SESSION_CONTROL_BYTES, SESSION_DATA_BUFFER_SIZE } from '../session/broker-types';
import type {
  WorkerInit,
  WorkerOutbound,
  WorkerResponseMsg,
  WorkerErrorMsg,
  WorkerRequestMsg,
} from './worker-types';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 500;

export interface DispatchResult {
  ok: true;
  status: number;
  headers: Record<string, string>;
  body: string;
  cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>;
}

interface PendingDispatch {
  id: number;
  msg: WorkerRequestMsg;
  resolve: (r: DispatchResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerSlot {
  worker: Worker;
  sessionChannel: SessionChannelHandler;
  pending: PendingDispatch | null;
  retiring: boolean;
  index: number;
}

export class RequestWorkerPool {
  private slots: (WorkerSlot | null)[] = [];
  private queue: PendingDispatch[] = [];
  private nextId = 0;
  private closed = false;

  constructor(
    private init: Omit<WorkerInit, 'sessionControlBuffer' | 'sessionDataBuffer'>,
    private size: number,
    private sessionStore: AnySessionStore,
    private timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    private maxQueueSize = DEFAULT_MAX_QUEUE
  ) {}

  async initialize(): Promise<void> {
    const slots = await Promise.all(
      Array.from({ length: this.size }, (_, i) => this.createSlot(i))
    );
    this.slots = slots;
  }

  private createSlot(index: number): Promise<WorkerSlot> {
    return new Promise((resolve, reject) => {
      const sessionControlBuffer = new SharedArrayBuffer(SESSION_CONTROL_BYTES);
      const sessionDataBuffer = new SharedArrayBuffer(SESSION_DATA_BUFFER_SIZE);
      const sessionChannel = new SessionChannelHandler(
        sessionControlBuffer, sessionDataBuffer, this.sessionStore
      );

      const workerInit: WorkerInit = {
        ...this.init,
        sessionControlBuffer,
        sessionDataBuffer,
      };

      const worker = new Worker(path.join(__dirname, 'request-worker.js'), {
        workerData: workerInit,
      });

      const slot: WorkerSlot = { worker, sessionChannel, pending: null, retiring: false, index };

      const onFirstMessage = (msg: WorkerOutbound) => {
        if (msg.type === 'ready') {
          worker.off('message', onFirstMessage);
          worker.on('message', (m: WorkerOutbound) => this.onWorkerMessage(slot, m));
          worker.on('error', (err) => {
            console.error(`[RequestWorkerPool] Worker ${index} error:`, err);
            this.handleWorkerCrash(slot);
          });
          resolve(slot);
        } else if (msg.type === 'fatal') {
          reject(new Error(`[RequestWorkerPool] Worker ${index} init failed: ${msg.message}`));
        }
      };

      worker.on('message', onFirstMessage);
      worker.on('error', reject);
    });
  }

  private onWorkerMessage(slot: WorkerSlot, msg: WorkerOutbound): void {
    // Session IPC: worker needs a session operation processed on the main thread.
    // Fire-and-forget the async Promise — the worker is already blocked on Atomics.wait.
    if (msg.type === 'session_op') {
      void slot.sessionChannel.handleOp();
      return;
    }

    if (msg.type !== 'response') return;

    const pending = slot.pending;
    if (!pending || pending.id !== msg.id) return;

    clearTimeout(pending.timer);
    slot.pending = null;

    if (msg.ok) {
      pending.resolve({
        ok: true,
        status: (msg as WorkerResponseMsg).status,
        headers: (msg as WorkerResponseMsg).headers,
        body: (msg as WorkerResponseMsg).body,
        cookies: (msg as WorkerResponseMsg).cookies,
      });
    } else {
      pending.reject(new Error((msg as WorkerErrorMsg).error));
    }

    if (msg.needsRestart || slot.retiring) {
      this.restartSlot(slot);
    } else {
      this.drainQueue(slot);
    }
  }

  private handleWorkerCrash(slot: WorkerSlot): void {
    if (slot.pending) {
      clearTimeout(slot.pending.timer);
      slot.pending.reject(new Error('Worker crashed'));
      slot.pending = null;
    }
    this.restartSlot(slot);
  }

  private restartSlot(slot: WorkerSlot): void {
    void slot.worker.terminate().catch(() => undefined);
    if (this.closed) return;

    this.createSlot(slot.index)
      .then((newSlot) => {
        this.slots[slot.index] = newSlot;
        this.drainQueue(newSlot);
      })
      .catch((err) => {
        console.error(`[RequestWorkerPool] Failed to restart worker ${slot.index}:`, err);
        this.slots[slot.index] = null;
        if (!this.closed) {
          setTimeout(() => {
            if (this.closed) return;
            this.createSlot(slot.index)
              .then((s) => { this.slots[slot.index] = s; this.drainQueue(s); })
              .catch((e) => console.error(`[RequestWorkerPool] Retry failed for slot ${slot.index}:`, e));
          }, 2000);
        }
      });
  }

  private drainQueue(slot: WorkerSlot): void {
    if (this.queue.length > 0 && !slot.pending && !slot.retiring) {
      const next = this.queue.shift()!;
      this.sendToSlot(slot, next);
    }
  }

  private sendToSlot(slot: WorkerSlot, dispatch: PendingDispatch): void {
    slot.pending = dispatch;
    slot.worker.postMessage(dispatch.msg);
  }

  dispatch(context: RequestContext, handlerIndex: number): Promise<DispatchResult> {
    if (this.closed) return Promise.reject(new Error('RequestWorkerPool is closed'));

    const id = this.nextId++;
    const msg: WorkerRequestMsg = { type: 'request', id, context, handlerIndex };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const qIdx = this.queue.findIndex((d) => d.id === id);
        if (qIdx >= 0) {
          this.queue.splice(qIdx, 1);
          reject(new Error(`Request ${id} timed out after ${this.timeoutMs}ms (queued)`));
          return;
        }
        const slot = this.slots.find((s) => s?.pending?.id === id);
        if (slot) slot.retiring = true;
        reject(new Error(`Request ${id} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const dispatch: PendingDispatch = { id, msg, resolve, reject, timer };

      const free = this.slots.find((s) => s && !s.pending && !s.retiring) as WorkerSlot | undefined;
      if (free) {
        this.sendToSlot(free, dispatch);
      } else {
        if (this.queue.length >= this.maxQueueSize) {
          clearTimeout(timer);
          reject(new Error('Server overloaded — request queue full'));
          return;
        }
        this.queue.push(dispatch);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const d of this.queue) {
      clearTimeout(d.timer);
      d.reject(new Error('Server shutting down'));
    }
    this.queue = [];
    await Promise.all(this.slots.map((s) => s?.worker.terminate().catch(() => undefined)));
    this.slots = [];
  }

  get availableCount(): number {
    return this.slots.filter((s) => s && !s.pending && !s.retiring).length;
  }

  get inUseCount(): number {
    return this.slots.filter((s) => s?.pending != null).length;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get totalWorkers(): number {
    return this.slots.filter(Boolean).length;
  }
}
