import { ServerConfig, RequestContext } from '../types';

// ── SSE Worker types ─────────────────────────────────────────────────────────

export interface SseWorkerInit {
  wasmPath: string;
  config: ServerConfig;
  databaseUrl?: string;
  sandboxRoot: string;
  /** 4-byte SAB: Int32Array[0] = 1 (connected) | 0 (disconnected). */
  sseControlBuffer: SharedArrayBuffer;
}

export interface SseWorkerRequestMsg {
  type: 'sse_request';
  context: RequestContext;
  /** Exported WASM function name to call (e.g. "handle_stream"). */
  handlerName: string;
}

export interface SseEmitMsg { type: 'sse_emit'; data: string; }
export interface SseEmitEventMsg { type: 'sse_emit_event'; name: string; data: string; }
export interface SseRetryMsg { type: 'sse_retry'; ms: number; }
export interface SseCloseMsg { type: 'sse_close'; }
export interface SseDoneMsg { type: 'sse_done'; }

export type SseWorkerInbound = SseWorkerRequestMsg;
export type SseWorkerOutbound =
  | SseEmitMsg
  | SseEmitEventMsg
  | SseRetryMsg
  | SseCloseMsg
  | SseDoneMsg
  | WorkerReadyMsg
  | WorkerFatalMsg;

// ── Request Worker types ─────────────────────────────────────────────────────

export interface WorkerInit {
  wasmPath: string;
  config: ServerConfig;
  databaseUrl?: string;
  sandboxRoot: string;
  /** SharedArrayBuffer pair for session IPC (worker ↔ main thread). */
  sessionControlBuffer: SharedArrayBuffer;
  sessionDataBuffer: SharedArrayBuffer;
  /** Per-worker PostgreSQL connection pool size. */
  pgMaxConnections?: number;
}

export interface WorkerRequestMsg {
  type: 'request';
  id: number;
  context: RequestContext;
  handlerIndex: number;
}

export interface WorkerResponseMsg {
  type: 'response';
  id: number;
  ok: true;
  status: number;
  headers: Record<string, string>;
  body: string;
  cookies: Array<{ name: string; value: string; options?: Record<string, unknown> | undefined }>;
  needsRestart: boolean;
}

export interface WorkerErrorMsg {
  type: 'response';
  id: number;
  ok: false;
  error: string;
  needsRestart: boolean;
}

export interface WorkerReadyMsg {
  type: 'ready';
}

export interface WorkerFatalMsg {
  type: 'fatal';
  message: string;
}

/** Sent by worker when it needs a session op processed by the main thread. */
export interface WorkerSessionOpMsg {
  type: 'session_op';
}

export type WorkerInbound = WorkerRequestMsg;
export type WorkerOutbound =
  | WorkerResponseMsg
  | WorkerErrorMsg
  | WorkerReadyMsg
  | WorkerFatalMsg
  | WorkerSessionOpMsg;
