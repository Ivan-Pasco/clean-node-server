import { Request, Response } from 'express';

/**
 * WASM module exports expected by the host bridge
 */
export interface WasmExports {
  memory: WebAssembly.Memory;
  malloc: (size: number) => number;
  free?: (ptr: number) => void;
  start?: () => void;
  _start?: () => void;
  [key: string]: unknown;
}

/**
 * Request context passed to WASM handlers
 */
export interface RequestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
  sessionId?: string;
}

/**
 * Session data stored in memory
 */
export interface SessionData {
  userId: string;
  role: string;
  claims: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

/**
 * Route handler registration
 */
export interface RouteHandler {
  method: string;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handlerIndex: number;
  isProtected: boolean;
  requiredRole?: string;
}

/**
 * Response from WASM handler
 */
export interface WasmResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  cookies?: Array<{
    name: string;
    value: string;
    options?: CookieOptions;
  }>;
}

/**
 * Cookie options
 */
export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  path?: string;
  domain?: string;
}

/**
 * Database query result
 */
export interface DbResult {
  ok: boolean;
  data?: {
    rows: Record<string, unknown>[];
    count: number;
  };
  err?: {
    code: string;
    message: string;
  };
}

/**
 * Bridge response envelope
 */
export interface BridgeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  err?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Database driver interface
 */
export interface DatabaseDriver {
  query(sql: string, params: unknown[]): Promise<DbResult>;
  execute(sql: string, params: unknown[]): Promise<number>;
  beginTransaction(): Promise<string>;
  commit(txId: string): Promise<void>;
  rollback(txId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl?: string;
  verbose: boolean;
  sessionSecret: string;
  jwtSecret: string;
}

/**
 * WASM instance state (per-request)
 */
export interface WasmState {
  instance: WebAssembly.Instance;
  exports: WasmExports;
  requestContext?: RequestContext;
  response: WasmResponse;
  config: ServerConfig;
  sessionStore: SessionStore;
  routeRegistry: RouteHandler[];
  database?: DatabaseDriver;
}

/**
 * Session store interface
 */
export interface SessionStore {
  create(data: Omit<SessionData, 'createdAt' | 'expiresAt'>, ttlSeconds?: number): string;
  get(sessionId: string): SessionData | undefined;
  destroy(sessionId: string): boolean;
  cleanup(): void;
}

/**
 * HTTP client response
 */
export interface HttpClientResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
