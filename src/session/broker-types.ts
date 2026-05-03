import { SessionData } from '../types';

export type SessionOp =
  | { op: 'create'; data: Omit<SessionData, 'createdAt' | 'expiresAt'>; ttlSeconds?: number }
  | { op: 'get'; sessionId: string }
  | { op: 'destroy'; sessionId: string }
  | { op: 'cleanup' }
  | { op: 'store_value'; sessionId: string; key: string; value: string }
  | { op: 'get_value'; sessionId: string; key: string }
  | { op: 'delete_value'; sessionId: string; key: string }
  | { op: 'has_key'; sessionId: string; key: string };

export interface SessionOpResult {
  ok: boolean;
  sessionId?: string;
  session?: SessionData;
  value?: string;
  found?: boolean;
}

export const SESSION_CONTROL_BYTES = 8;
export const SESSION_DATA_BUFFER_SIZE = 256 * 1024;

export const SESSION_IDLE = 0;
export const SESSION_PENDING = 1;
export const SESSION_DONE = 2;
export const SESSION_TIMEOUT_MS = 5_000;
