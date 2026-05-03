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
  // Optional synchronous methods for drivers that support them (e.g. SQLite via better-sqlite3)
  querySync?(sql: string, params: unknown[]): DbResult;
  executeSync?(sql: string, params: unknown[]): number;
  beginTransactionSync?(): string;
  commitSync?(txId: string): void;
  rollbackSync?(txId: string): void;
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
  memoryLimitBytes?: number;
  tlsCert?: string;
  tlsKey?: string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  corsOrigin?: string;
  pgPoolSize?: number;
}

/**
 * Per-request memory statistics
 */
export interface MemoryStats {
  initialMemorySize: number;
  peakMemorySize: number;
  initialHeapPtr: number;
  peakAllocation: number;
  growCount: number;
  allocCount: number;
  oomCount: number;
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
  injectedCss?: string[];
  projectRoot?: string;
  memoryStats: MemoryStats;
  httpClient: HttpClientState;
  httpWorker?: SyncHttpWorker;
}

/**
 * Session store interface (synchronous — InMemorySessionStore)
 */
export interface SessionStore {
  create(data: Omit<SessionData, 'createdAt' | 'expiresAt'>, ttlSeconds?: number): string;
  get(sessionId: string): SessionData | undefined;
  destroy(sessionId: string): boolean;
  cleanup(): void;
  storeValue?(sessionId: string, key: string, value: string): boolean;
  getValue?(sessionId: string, key: string): string | undefined;
  deleteValue?(sessionId: string, key: string): boolean;
  hasKey?(sessionId: string, key: string): boolean;
}

/**
 * Unified session store type that accepts both sync (in-memory) and async (Redis) stores.
 * Each method returns `T | Promise<T>` so callers can `await` safely regardless of implementation.
 */
export interface AnySessionStore {
  create(data: Omit<SessionData, 'createdAt' | 'expiresAt'>, ttlSeconds?: number): string | Promise<string>;
  get(sessionId: string): SessionData | undefined | Promise<SessionData | undefined>;
  destroy(sessionId: string): boolean | Promise<boolean>;
  cleanup(): void | Promise<void>;
  close(): void | Promise<void>;
  storeValue?(sessionId: string, key: string, value: string): boolean | Promise<boolean>;
  getValue?(sessionId: string, key: string): string | undefined | Promise<string | undefined>;
  deleteValue?(sessionId: string, key: string): boolean | Promise<boolean>;
  hasKey?(sessionId: string, key: string): boolean | Promise<boolean>;
}

/**
 * HTTP client response
 */
export interface HttpClientResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Per-instance HTTP client configuration and state
 */
export interface HttpClientState {
  timeout: number;
  userAgent: string | null;
  maxRedirects: number;
  cookiesEnabled: boolean;
  cookieJar: Map<string, string>;
  lastResponse: HttpClientResponse | null;
}

/**
 * Request payload sent to HTTP worker thread
 */
export interface HttpWorkerRequest {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
  timeout: number;
  maxRedirects: number;
  cookiesEnabled: boolean;
  cookies: Record<string, string>;
}

/**
 * Response received from HTTP worker thread
 */
export interface HttpWorkerResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  updatedCookies: Record<string, string>;
}

/**
 * Synchronous HTTP worker interface (backed by a worker thread)
 */
export interface SyncHttpWorker {
  request(opts: HttpWorkerRequest): HttpWorkerResponse;
  close(): void;
}
