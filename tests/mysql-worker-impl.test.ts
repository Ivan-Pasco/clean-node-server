/**
 * mysql-worker-impl tests — RUNTIME-DB-POOL-WEDGE regression suite.
 *
 * The wedge happens when a connection that errored mid-stream gets returned to
 * the pool via release() instead of being destroyed. The next consumer reads
 * leftover packets and trips PROTOCOL_PACKETS_OUT_OF_ORDER. These tests
 * exercise every error path that touches a connection and assert destroy() is
 * called, not release().
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleRequest,
  closePoolWithTimeout,
  ConnLike,
  PoolLike,
} from '../src/database/mysql-worker-impl';

function makeConn(overrides: Partial<ConnLike> = {}): ConnLike & {
  release: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    release: vi.fn(),
    destroy: vi.fn(),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([[], undefined]),
    execute: vi.fn().mockResolvedValue([{ affectedRows: 0, insertId: 0 }, undefined]),
    ...overrides,
  } as ConnLike & {
    release: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}

function makePool(conn: ConnLike, overrides: Partial<PoolLike> = {}): PoolLike {
  return {
    getConnection: vi.fn().mockResolvedValue(conn),
    query: vi.fn().mockResolvedValue([[], undefined]),
    execute: vi.fn().mockResolvedValue([{ affectedRows: 0, insertId: 0 }, undefined]),
    end: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('handleRequest — begin', () => {
  it('destroys the connection if beginTransaction throws', async () => {
    const conn = makeConn({
      beginTransaction: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const pool = makePool(conn);
    const transactions = new Map<string, ConnLike>();

    const res = await handleRequest({ op: 'begin' }, { pool, transactions });

    expect(res.ok).toBe(false);
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.release).not.toHaveBeenCalled();
    expect(transactions.size).toBe(0);
  });

  it('stores the connection in transactions on success', async () => {
    const conn = makeConn();
    const pool = makePool(conn);
    const transactions = new Map<string, ConnLike>();

    const res = await handleRequest({ op: 'begin' }, { pool, transactions });

    expect(res.ok).toBe(true);
    expect(transactions.size).toBe(1);
    expect(conn.destroy).not.toHaveBeenCalled();
    expect(conn.release).not.toHaveBeenCalled();
  });
});

describe('handleRequest — commit', () => {
  it('destroys the connection (not release) when commit throws', async () => {
    const conn = makeConn({
      commit: vi.fn().mockRejectedValue(new Error('packets out of order')),
    });
    const pool = makePool(conn);
    const transactions = new Map<string, ConnLike>([['tx_1', conn]]);

    const res = await handleRequest({ op: 'commit', txId: 'tx_1' }, { pool, transactions });

    expect(res.ok).toBe(false);
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.release).not.toHaveBeenCalled();
    expect(transactions.size).toBe(0);
  });

  it('releases the connection on commit success', async () => {
    const conn = makeConn();
    const pool = makePool(conn);
    const transactions = new Map<string, ConnLike>([['tx_1', conn]]);

    const res = await handleRequest({ op: 'commit', txId: 'tx_1' }, { pool, transactions });

    expect(res.ok).toBe(true);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
    expect(transactions.size).toBe(0);
  });
});

describe('handleRequest — rollback', () => {
  it('destroys the connection (not release) when rollback throws', async () => {
    const conn = makeConn({
      rollback: vi.fn().mockRejectedValue(new Error('connection lost')),
    });
    const pool = makePool(conn);
    const transactions = new Map<string, ConnLike>([['tx_1', conn]]);

    const res = await handleRequest({ op: 'rollback', txId: 'tx_1' }, { pool, transactions });

    expect(res.ok).toBe(false);
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.release).not.toHaveBeenCalled();
    expect(transactions.size).toBe(0);
  });

  it('releases the connection on rollback success', async () => {
    const conn = makeConn();
    const pool = makePool(conn);
    const transactions = new Map<string, ConnLike>([['tx_1', conn]]);

    const res = await handleRequest({ op: 'rollback', txId: 'tx_1' }, { pool, transactions });

    expect(res.ok).toBe(true);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
    expect(transactions.size).toBe(0);
  });
});

describe('handleRequest — query / execute', () => {
  it('one-shot query destroys connection on error', async () => {
    const conn = makeConn({
      query: vi.fn().mockRejectedValue(new Error('mid-stream failure')),
    });
    const pool = makePool(conn);

    const res = await handleRequest(
      { op: 'query', sql: 'SELECT 1', params: [] },
      { pool, transactions: new Map() },
    );

    expect(res.ok).toBe(false);
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.release).not.toHaveBeenCalled();
  });

  it('one-shot query releases connection on success', async () => {
    const conn = makeConn({
      query: vi.fn().mockResolvedValue([[{ id: 1 }], undefined]),
    });
    const pool = makePool(conn);

    const res = await handleRequest(
      { op: 'query', sql: 'SELECT 1', params: [] },
      { pool, transactions: new Map() },
    );

    expect(res.ok).toBe(true);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it('tx-bound query failure destroys the tx connection and drops the txId', async () => {
    const conn = makeConn({
      query: vi.fn().mockRejectedValue(new Error('mid-tx error')),
    });
    const pool = makePool(conn);
    const transactions = new Map<string, ConnLike>([['tx_1', conn]]);

    const res = await handleRequest(
      { op: 'query', sql: 'SELECT 1', params: [], txId: 'tx_1' },
      { pool, transactions },
    );

    expect(res.ok).toBe(false);
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.release).not.toHaveBeenCalled();
    expect(transactions.has('tx_1')).toBe(false);
  });
});

describe('closePoolWithTimeout', () => {
  it('returns clean=true when pool.end resolves before the timer', async () => {
    const pool = makePool(makeConn(), { end: vi.fn().mockResolvedValue(undefined) });
    const result = await closePoolWithTimeout(pool, 1_000);
    expect(result.clean).toBe(true);
  });

  it('returns clean=false when pool.end hangs past the timeout', async () => {
    const pool = makePool(makeConn(), {
      // Hangs forever — simulates the wedge: pool.end() awaits in-flight queries
      // that never resolve.
      end: vi.fn().mockImplementation(() => new Promise<void>(() => undefined)),
    });
    const result = await closePoolWithTimeout(pool, 50);
    expect(result.clean).toBe(false);
  });

  it('handleRequest close still resolves when pool.end hangs', async () => {
    const pool = makePool(makeConn(), {
      end: vi.fn().mockImplementation(() => new Promise<void>(() => undefined)),
    });
    // Use a tiny timeout via the impl indirectly — close uses 5s internally,
    // so just verify the call doesn't hang the test runner under the default
    // 5s. We accept the close test takes ~5s in CI.
    const res = await handleRequest({ op: 'close' }, { pool, transactions: new Map() });
    expect(res.ok).toBe(true);
  }, 10_000);
});
