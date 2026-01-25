import { DatabaseDriver, DbResult } from '../types';

/**
 * Parse a database URL and create the appropriate driver
 *
 * Supported formats:
 * - postgres://user:pass@host:port/database
 * - postgresql://user:pass@host:port/database
 * - sqlite:///path/to/database.db
 * - sqlite::memory:
 */
export async function createDatabaseDriver(url: string): Promise<DatabaseDriver> {
  const protocol = url.split('://')[0].toLowerCase();

  switch (protocol) {
    case 'postgres':
    case 'postgresql': {
      const { PostgresDriver } = await import('./postgres');
      return new PostgresDriver(url);
    }

    case 'sqlite': {
      const { SqliteDriver } = await import('./sqlite');
      const dbPath = url.replace('sqlite://', '');
      return new SqliteDriver(dbPath);
    }

    default:
      throw new Error(`Unsupported database protocol: ${protocol}`);
  }
}

/**
 * Format database result as standard response
 */
export function formatDbResult(rows: Record<string, unknown>[]): DbResult {
  return {
    ok: true,
    data: {
      rows,
      count: rows.length,
    },
  };
}

/**
 * Format database error as standard response
 */
export function formatDbError(err: Error): DbResult {
  return {
    ok: false,
    err: {
      code: 'DB_ERROR',
      message: err.message,
    },
  };
}

/**
 * Parse JSON parameters for database queries
 */
export function parseDbParams(paramsJson: string): unknown[] {
  if (!paramsJson || paramsJson === '[]') {
    return [];
  }

  try {
    return JSON.parse(paramsJson) as unknown[];
  } catch {
    return [];
  }
}
