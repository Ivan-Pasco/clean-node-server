import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';
import { createDatabaseDriver } from '../database';

/**
 * Registered migration names in declared order
 */
const registeredMigrations: string[] = [];

/**
 * Result cache for async migration operations (follows the same pattern as database.ts)
 */
let lastMigrationDiffResult: string = '';
let lastMigrationsApplied: number = 0;

/**
 * Convert a migration name to a clean identifier suitable for WASM export names.
 * Replaces hyphens, dots, and spaces with underscores.
 */
function toCleanName(name: string): string {
  return name.replace(/[-.\s]/g, '_');
}

/**
 * Detect the database engine from the configured driver.
 * Returns 'postgres', 'sqlite', or 'unknown'.
 */
function detectEngine(state: WasmState): 'postgres' | 'sqlite' | 'unknown' {
  if (!state.database) {
    return 'unknown';
  }

  const ctor = state.database.constructor?.name ?? '';

  if (ctor === 'PostgresDriver') {
    return 'postgres';
  }

  if (ctor === 'SqliteDriver') {
    return 'sqlite';
  }

  return 'unknown';
}

/**
 * Parse field definitions string into an array of column descriptors.
 *
 * Accepts a comma-separated list such as:
 *   "name TEXT, email TEXT UNIQUE, age INTEGER"
 *
 * Returns objects with { columnName, dataType, rest } where rest contains
 * any additional constraints (e.g. UNIQUE, NOT NULL).
 */
interface ColumnDef {
  columnName: string;
  dataType: string;
  rest: string;
}

function parseFieldDefs(fieldDefs: string): ColumnDef[] {
  if (!fieldDefs.trim()) {
    return [];
  }

  return fieldDefs
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const tokens = part.split(/\s+/);
      const columnName = tokens[0] ?? '';
      const dataType = tokens[1] ?? 'TEXT';
      const rest = tokens.slice(2).join(' ');
      return { columnName, dataType, rest };
    });
}

/**
 * Create migration bridge functions
 */
export function createMigrationBridge(getState: () => WasmState) {
  return {
    /**
     * Configure the database connection from component parts.
     *
     * Parameters (14 i32 values):
     *   enginePtr, engineLen   – database engine: "postgres" | "mysql" | "sqlite"
     *   hostPtr,   hostLen     – hostname or IP
     *   portPtr,   portLen     – port number as string (e.g. "5432")
     *   dbPtr,     dbLen       – database name / file path
     *   userPtr,   userLen     – username
     *   passPtr,   passLen     – password
     *   poolMax                – maximum pool connections (integer)
     *   poolIdleTimeout        – pool idle timeout in milliseconds (integer)
     *
     * Returns 0 on success, -1 on error.
     */
    _db_configure(
      enginePtr: number,
      engineLen: number,
      hostPtr: number,
      hostLen: number,
      portPtr: number,
      portLen: number,
      dbPtr: number,
      dbLen: number,
      userPtr: number,
      userLen: number,
      passPtr: number,
      passLen: number,
      poolMax: number,
      poolIdleTimeout: number
    ): number {
      const state = getState();

      const engine = readString(state, enginePtr, engineLen).toLowerCase();
      const host = readString(state, hostPtr, hostLen);
      const port = readString(state, portPtr, portLen);
      const database = readString(state, dbPtr, dbLen);
      const user = readString(state, userPtr, userLen);
      const password = readString(state, passPtr, passLen);

      log(state, 'MIGRATION', `Configuring database: engine=${engine}, host=${host}, port=${port}, db=${database}, poolMax=${poolMax}, idleTimeout=${poolIdleTimeout}`);

      let url: string;

      switch (engine) {
        case 'postgres':
        case 'postgresql': {
          const encodedUser = encodeURIComponent(user);
          const encodedPass = encodeURIComponent(password);
          const portPart = port ? `:${port}` : '';
          url = `postgres://${encodedUser}:${encodedPass}@${host}${portPart}/${database}`;
          break;
        }

        case 'mysql': {
          const encodedUser = encodeURIComponent(user);
          const encodedPass = encodeURIComponent(password);
          const portPart = port ? `:${port}` : '';
          url = `mysql://${encodedUser}:${encodedPass}@${host}${portPart}/${database}`;
          break;
        }

        case 'sqlite': {
          // For SQLite the "database" field is the file path
          url = `sqlite://${database}`;
          break;
        }

        default: {
          log(state, 'MIGRATION', `Unsupported database engine: ${engine}`);
          return -1;
        }
      }

      createDatabaseDriver(url).then((driver) => {
        state.database = driver;
        log(state, 'MIGRATION', `Database configured successfully (poolMax=${poolMax}, idleTimeout=${poolIdleTimeout}ms)`);
      }).catch((err) => {
        log(state, 'MIGRATION', `Failed to configure database: ${(err as Error).message}`);
      });

      return 0;
    },

    /**
     * Register a migration by name.
     *
     * The migration's WASM up/down exports must be named:
     *   __migration_{cleanName}_up()
     *   __migration_{cleanName}_down()
     * where cleanName replaces hyphens, dots, and spaces with underscores.
     *
     * Returns 1 on success.
     */
    _db_register_migration(namePtr: number, nameLen: number): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen);

      if (!name.trim()) {
        log(state, 'MIGRATION', 'Attempted to register migration with empty name');
        return 0;
      }

      if (!registeredMigrations.includes(name)) {
        registeredMigrations.push(name);
        log(state, 'MIGRATION', `Registered migration: ${name}`);
      }

      return 1;
    },

    /**
     * Compare a declared model schema against the live database table.
     *
     * tableName   – name of the database table
     * fieldDefs   – comma-separated column definitions, e.g.
     *               "name TEXT, email TEXT UNIQUE, age INTEGER"
     *
     * Generates ALTER TABLE statements for new columns.
     * Type-mismatch handling: ALTER for PostgreSQL, ignored for SQLite.
     * Missing columns (columns in DB but not in model) are never dropped.
     *
     * Returns a pointer to the ALTER TABLE SQL string, or empty string if no changes needed.
     */
    _db_migration_diff(
      tableNamePtr: number,
      tableNameLen: number,
      fieldDefsPtr: number,
      fieldDefsLen: number
    ): number {
      const state = getState();

      if (!state.database) {
        log(state, 'MIGRATION', '_db_migration_diff called without database configured');
        return writeString(state, '');
      }

      const tableName = readString(state, tableNamePtr, tableNameLen);
      const fieldDefs = readString(state, fieldDefsPtr, fieldDefsLen);
      const engine = detectEngine(state);
      const declaredColumns = parseFieldDefs(fieldDefs);

      log(state, 'MIGRATION', `Diffing table '${tableName}' with ${declaredColumns.length} declared columns (engine=${engine})`);

      if (engine === 'postgres') {
        state.database
          .query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
            [tableName]
          )
          .then((result) => {
            if (!result.ok || !result.data) {
              lastMigrationDiffResult = '';
              return;
            }

            const existingColumns = new Map<string, string>();
            for (const row of result.data.rows) {
              const colName = String(row['column_name'] ?? '').toLowerCase();
              const colType = String(row['data_type'] ?? '').toLowerCase();
              existingColumns.set(colName, colType);
            }

            const alterStatements: string[] = [];

            for (const col of declaredColumns) {
              const colLower = col.columnName.toLowerCase();
              if (!existingColumns.has(colLower)) {
                const constraintPart = col.rest ? ` ${col.rest}` : '';
                alterStatements.push(
                  `ALTER TABLE ${tableName} ADD COLUMN ${col.columnName} ${col.dataType}${constraintPart};`
                );
              } else {
                const existingType = existingColumns.get(colLower) ?? '';
                const declaredTypeLower = col.dataType.toLowerCase();
                if (existingType !== declaredTypeLower) {
                  alterStatements.push(
                    `ALTER TABLE ${tableName} ALTER COLUMN ${col.columnName} TYPE ${col.dataType};`
                  );
                }
              }
            }

            lastMigrationDiffResult = alterStatements.join('\n');
          })
          .catch((err) => {
            log(state, 'MIGRATION', `Failed to diff table '${tableName}': ${(err as Error).message}`);
            lastMigrationDiffResult = '';
          });
      } else if (engine === 'sqlite') {
        state.database
          .query(`PRAGMA table_info(${tableName})`, [])
          .then((result) => {
            if (!result.ok || !result.data) {
              lastMigrationDiffResult = '';
              return;
            }

            const existingColumns = new Set<string>();
            for (const row of result.data.rows) {
              const colName = String(row['name'] ?? '').toLowerCase();
              existingColumns.add(colName);
            }

            const alterStatements: string[] = [];

            for (const col of declaredColumns) {
              const colLower = col.columnName.toLowerCase();
              if (!existingColumns.has(colLower)) {
                const constraintPart = col.rest ? ` ${col.rest}` : '';
                alterStatements.push(
                  `ALTER TABLE ${tableName} ADD COLUMN ${col.columnName} ${col.dataType}${constraintPart};`
                );
              }
              // SQLite does not support altering column types; type mismatches are ignored
            }

            lastMigrationDiffResult = alterStatements.join('\n');
          })
          .catch((err) => {
            log(state, 'MIGRATION', `Failed to diff table '${tableName}': ${(err as Error).message}`);
            lastMigrationDiffResult = '';
          });
      } else {
        log(state, 'MIGRATION', `Cannot diff table for unknown engine`);
      }

      return writeString(state, lastMigrationDiffResult);
    },

    /**
     * Run all pending migrations in registration order.
     *
     * Ensures the _migrations tracking table exists, then for each registered
     * migration not yet applied: calls its WASM up export and records it.
     *
     * Returns the count of migrations that were applied.
     */
    _db_run_migrations(): number {
      const state = getState();

      if (!state.database) {
        log(state, 'MIGRATION', '_db_run_migrations called without database configured');
        return 0;
      }

      const engine = detectEngine(state);
      const isPostgres = engine === 'postgres';

      const createTableSql = isPostgres
        ? `CREATE TABLE IF NOT EXISTS _migrations (
             name TEXT PRIMARY KEY,
             applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
           );`
        : `CREATE TABLE IF NOT EXISTS _migrations (
             name TEXT PRIMARY KEY,
             applied_at TEXT DEFAULT (datetime('now'))
           );`;

      state.database
        .execute(createTableSql, [])
        .then(async () => {
          const listSql = isPostgres
            ? `SELECT name FROM _migrations ORDER BY applied_at ASC`
            : `SELECT name FROM _migrations ORDER BY applied_at ASC`;

          const listResult = await state.database!.query(listSql, []);

          const appliedSet = new Set<string>();
          if (listResult.ok && listResult.data) {
            for (const row of listResult.data.rows) {
              appliedSet.add(String(row['name'] ?? ''));
            }
          }

          let applied = 0;

          for (const name of registeredMigrations) {
            if (appliedSet.has(name)) {
              continue;
            }

            const cleanName = toCleanName(name);
            const upExportName = `__migration_${cleanName}_up`;
            const upFn = state.exports[upExportName];

            if (typeof upFn === 'function') {
              try {
                (upFn as () => void)();
              } catch (err) {
                log(state, 'MIGRATION', `Migration '${name}' up() threw: ${(err as Error).message}`);
                break;
              }
            } else {
              log(state, 'MIGRATION', `Migration '${name}' has no WASM export '${upExportName}', skipping`);
            }

            const insertSql = isPostgres
              ? `INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`
              : `INSERT OR IGNORE INTO _migrations (name) VALUES (?)`;

            await state.database!.execute(insertSql, [name]);
            applied++;
            log(state, 'MIGRATION', `Applied migration: ${name}`);
          }

          lastMigrationsApplied = applied;
        })
        .catch((err) => {
          log(state, 'MIGRATION', `_db_run_migrations failed: ${(err as Error).message}`);
          lastMigrationsApplied = 0;
        });

      return lastMigrationsApplied;
    },

    /**
     * Roll back a single named migration.
     *
     * Calls the migration's WASM down export and removes the record from _migrations.
     *
     * Returns 1 on success, 0 if the migration was not applied.
     */
    _db_rollback_migration(namePtr: number, nameLen: number): number {
      const state = getState();

      if (!state.database) {
        log(state, 'MIGRATION', '_db_rollback_migration called without database configured');
        return 0;
      }

      const name = readString(state, namePtr, nameLen);
      const engine = detectEngine(state);
      const isPostgres = engine === 'postgres';

      const checkSql = isPostgres
        ? `SELECT name FROM _migrations WHERE name = $1`
        : `SELECT name FROM _migrations WHERE name = ?`;

      let rollbackResult = 0;

      state.database
        .query(checkSql, [name])
        .then(async (checkResult) => {
          if (!checkResult.ok || !checkResult.data || checkResult.data.rows.length === 0) {
            log(state, 'MIGRATION', `Migration '${name}' is not applied, nothing to roll back`);
            rollbackResult = 0;
            return;
          }

          const cleanName = toCleanName(name);
          const downExportName = `__migration_${cleanName}_down`;
          const downFn = state.exports[downExportName];

          if (typeof downFn === 'function') {
            try {
              (downFn as () => void)();
            } catch (err) {
              log(state, 'MIGRATION', `Migration '${name}' down() threw: ${(err as Error).message}`);
              rollbackResult = 0;
              return;
            }
          } else {
            log(state, 'MIGRATION', `Migration '${name}' has no WASM export '${downExportName}', proceeding with DB record deletion only`);
          }

          const deleteSql = isPostgres
            ? `DELETE FROM _migrations WHERE name = $1`
            : `DELETE FROM _migrations WHERE name = ?`;

          await state.database!.execute(deleteSql, [name]);
          log(state, 'MIGRATION', `Rolled back migration: ${name}`);
          rollbackResult = 1;
        })
        .catch((err) => {
          log(state, 'MIGRATION', `_db_rollback_migration failed for '${name}': ${(err as Error).message}`);
          rollbackResult = 0;
        });

      return rollbackResult;
    },

    /**
     * Return the status of all registered migrations as a JSON array.
     *
     * Each entry has the shape:
     *   { "name": "001_create_users", "applied": true, "applied_at": "2026-03-22T..." }
     * or
     *   { "name": "002_add_email", "applied": false, "applied_at": null }
     *
     * Returns a pointer to the JSON string.
     */
    _db_migration_status(): number {
      const state = getState();

      if (!state.database) {
        const empty = registeredMigrations.map((name) => ({
          name,
          applied: false,
          applied_at: null,
        }));
        return writeString(state, JSON.stringify(empty));
      }

      const engine = detectEngine(state);
      const isPostgres = engine === 'postgres';

      const selectSql = isPostgres
        ? `SELECT name, applied_at FROM _migrations`
        : `SELECT name, applied_at FROM _migrations`;

      let statusResult = JSON.stringify(
        registeredMigrations.map((name) => ({ name, applied: false, applied_at: null }))
      );

      state.database
        .query(selectSql, [])
        .then((result) => {
          const appliedMap = new Map<string, string>();

          if (result.ok && result.data) {
            for (const row of result.data.rows) {
              const rowName = String(row['name'] ?? '');
              const rowAppliedAt = row['applied_at'] != null ? String(row['applied_at']) : '';
              appliedMap.set(rowName, rowAppliedAt);
            }
          }

          const statuses = registeredMigrations.map((name) => {
            const isApplied = appliedMap.has(name);
            return {
              name,
              applied: isApplied,
              applied_at: isApplied ? (appliedMap.get(name) ?? null) : null,
            };
          });

          statusResult = JSON.stringify(statuses);
        })
        .catch((err) => {
          log(state, 'MIGRATION', `_db_migration_status failed: ${(err as Error).message}`);
        });

      return writeString(state, statusResult);
    },
  };
}

/**
 * Reset the registered migrations list (for testing purposes)
 */
export function resetRegisteredMigrations(): void {
  registeredMigrations.length = 0;
}

/**
 * Get a copy of the registered migrations list (for testing purposes)
 */
export function getRegisteredMigrations(): string[] {
  return [...registeredMigrations];
}
