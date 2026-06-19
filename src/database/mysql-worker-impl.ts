// RUNTIME-DB-POOL-WEDGE: mysql2's pool returns connections to the queue when
// release() is called. If the connection still has un-consumed response bytes
// on the wire — which can happen when commit/rollback errors mid-stream — the
// next consumer reads those packets and trips
// `PROTOCOL_PACKETS_OUT_OF_ORDER`, wedging that slot. Repeat across the pool
// and the whole event loop locks up. Every error path here destroys the
// connection instead of releasing it.
import type { ExecuteValues, ResultSetHeader } from 'mysql2/promise';

export interface ConnLike {
  release(): void;
  destroy(): void;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  query(sql: string, params: ExecuteValues): Promise<[unknown, unknown]>;
  execute(sql: string, params: ExecuteValues): Promise<[unknown, unknown]>;
}

export interface PoolLike {
  getConnection(): Promise<ConnLike>;
  query(sql: string, params: ExecuteValues): Promise<[unknown, unknown]>;
  execute(sql: string, params: ExecuteValues): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

export type WorkerRequest =
  | { op: 'query'; sql: string; params?: unknown[]; txId?: string }
  | { op: 'execute'; sql: string; params?: unknown[]; txId?: string }
  | { op: 'begin' }
  | { op: 'commit'; txId: string }
  | { op: 'rollback'; txId: string }
  | { op: 'close' };

export type WorkerResponse =
  | { ok: true; data?: unknown; txId?: string; count?: number; insertId?: number | null }
  | { ok: false; err: { code: string; message: string } };

export interface HandlerDeps {
  pool: PoolLike;
  transactions: Map<string, ConnLike>;
  log?: (level: 'warn' | 'error' | 'info', msg: string, extra?: Record<string, unknown>) => void;
}

type Log = NonNullable<HandlerDeps['log']>;
const noLog: Log = () => undefined;

function errResponse(code: string, message: string): WorkerResponse {
  return { ok: false, err: { code, message } };
}

function safeDestroy(conn: ConnLike | undefined, log: Log): void {
  if (!conn) return;
  try {
    conn.destroy();
  } catch (err) {
    log('warn', 'mysql conn.destroy() threw', { err: (err as Error).message });
  }
}

function safeRelease(conn: ConnLike, log: Log): void {
  try {
    conn.release();
  } catch (err) {
    log('warn', 'mysql conn.release() threw', { err: (err as Error).message });
  }
}

export async function handleRequest(
  req: WorkerRequest,
  deps: HandlerDeps,
): Promise<WorkerResponse> {
  const { pool, transactions } = deps;
  const log = deps.log ?? noLog;

  switch (req.op) {
    case 'query':
      return handleQuery(pool, transactions, req, log);
    case 'execute':
      return handleExecute(pool, transactions, req, log);
    case 'begin':
      return handleBegin(pool, transactions, log);
    case 'commit':
      return handleCommit(transactions, req.txId, log);
    case 'rollback':
      return handleRollback(transactions, req.txId, log);
    case 'close':
      return handleClose(pool, transactions, log);
    default:
      return errResponse('UNKNOWN_OP', `Unknown operation: ${(req as { op: string }).op}`);
  }
}

async function handleQuery(
  pool: PoolLike,
  transactions: Map<string, ConnLike>,
  req: { sql: string; params?: unknown[]; txId?: string },
  log: Log,
): Promise<WorkerResponse> {
  const qparams = (req.params ?? []) as ExecuteValues;

  // Transaction-bound query: connection lifetime is the transaction's. If the
  // query errors, the connection is no longer trustworthy — destroy it, drop
  // the tx entry. Subsequent commit/rollback on this txId returns TX_NOT_FOUND.
  if (req.txId) {
    const conn = transactions.get(req.txId);
    if (!conn) {
      return errResponse('TX_NOT_FOUND', `Transaction not found: ${req.txId}`);
    }
    try {
      const [rows] = await conn.query(req.sql, qparams);
      const rowArray = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
      return { ok: true, data: { ok: true, data: { rows: rowArray, count: rowArray.length } } };
    } catch (err) {
      transactions.delete(req.txId);
      safeDestroy(conn, log);
      return errResponse('DB_ERROR', (err as Error).message);
    }
  }

  // One-shot query: explicit getConnection so we control the error path. The
  // pool.query convenience method releases on error which is the wedge.
  let conn: ConnLike | undefined;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(req.sql, qparams);
    const rowArray = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    safeRelease(conn, log);
    return { ok: true, data: { ok: true, data: { rows: rowArray, count: rowArray.length } } };
  } catch (err) {
    safeDestroy(conn, log);
    return errResponse('DB_ERROR', (err as Error).message);
  }
}

async function handleExecute(
  pool: PoolLike,
  transactions: Map<string, ConnLike>,
  req: { sql: string; params?: unknown[]; txId?: string },
  log: Log,
): Promise<WorkerResponse> {
  const params = (req.params ?? []) as ExecuteValues;

  const headerToResponse = (header: ResultSetHeader): WorkerResponse => {
    const affectedRows = header.affectedRows ?? 0;
    const rawInsertId = header.insertId;
    const insertId =
      typeof rawInsertId === 'number' && rawInsertId > 0 ? rawInsertId : null;
    return { ok: true, count: affectedRows, insertId };
  };

  if (req.txId) {
    const conn = transactions.get(req.txId);
    if (!conn) {
      return errResponse('TX_NOT_FOUND', `Transaction not found: ${req.txId}`);
    }
    try {
      const [result] = await conn.execute(req.sql, params);
      return headerToResponse(result as ResultSetHeader);
    } catch (err) {
      transactions.delete(req.txId);
      safeDestroy(conn, log);
      return errResponse('DB_ERROR', (err as Error).message);
    }
  }

  let conn: ConnLike | undefined;
  try {
    conn = await pool.getConnection();
    const [result] = await conn.execute(req.sql, params);
    safeRelease(conn, log);
    return headerToResponse(result as ResultSetHeader);
  } catch (err) {
    safeDestroy(conn, log);
    return errResponse('DB_ERROR', (err as Error).message);
  }
}

async function handleBegin(
  pool: PoolLike,
  transactions: Map<string, ConnLike>,
  log: Log,
): Promise<WorkerResponse> {
  let conn: ConnLike | undefined;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    transactions.set(txId, conn);
    return { ok: true, txId };
  } catch (err) {
    // beginTransaction error on a checked-out connection: destroy. Releasing
    // would put a connection back into the pool whose state we no longer trust.
    safeDestroy(conn, log);
    return errResponse('DB_ERROR', (err as Error).message);
  }
}

async function handleCommit(
  transactions: Map<string, ConnLike>,
  txId: string,
  log: Log,
): Promise<WorkerResponse> {
  const conn = transactions.get(txId);
  if (!conn) {
    return errResponse('TX_NOT_FOUND', `Transaction not found: ${txId}`);
  }
  transactions.delete(txId);
  try {
    await conn.commit();
    safeRelease(conn, log);
    return { ok: true };
  } catch (err) {
    safeDestroy(conn, log);
    return errResponse('DB_ERROR', (err as Error).message);
  }
}

async function handleRollback(
  transactions: Map<string, ConnLike>,
  txId: string,
  log: Log,
): Promise<WorkerResponse> {
  const conn = transactions.get(txId);
  if (!conn) {
    return errResponse('TX_NOT_FOUND', `Transaction not found: ${txId}`);
  }
  transactions.delete(txId);
  try {
    await conn.rollback();
    safeRelease(conn, log);
    return { ok: true };
  } catch (err) {
    safeDestroy(conn, log);
    return errResponse('DB_ERROR', (err as Error).message);
  }
}

async function handleClose(
  pool: PoolLike,
  transactions: Map<string, ConnLike>,
  log: Log,
): Promise<WorkerResponse> {
  for (const conn of transactions.values()) {
    try {
      await conn.rollback();
      safeRelease(conn, log);
    } catch {
      safeDestroy(conn, log);
    }
  }
  transactions.clear();

  const result = await closePoolWithTimeout(pool, 5_000, log);
  if (!result.clean) {
    log('warn', 'mysql pool.end() exceeded timeout; abandoning pool', { timeoutMs: 5_000 });
  }
  return { ok: true };
}

// Graceful shutdown must be bounded: pool.end() waits for in-flight queries to
// finish, and the bug we are fixing is wedged queries. Race against a timer so
// SIGTERM completes inside systemd's TimeoutStopSec.
export async function closePoolWithTimeout(
  pool: PoolLike,
  timeoutMs: number,
  log: Log = noLog,
): Promise<{ clean: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ clean: false }>((resolve) => {
    timer = setTimeout(() => resolve({ clean: false }), timeoutMs);
  });
  const end = pool.end().then(
    () => ({ clean: true as const }),
    (err) => {
      log('warn', 'mysql pool.end() rejected', { err: (err as Error).message });
      return { clean: true as const };
    },
  );
  try {
    return await Promise.race([end, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
