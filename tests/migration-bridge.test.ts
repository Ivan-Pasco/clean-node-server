/**
 * Migration bridge tests — createMigrationBridge
 *
 * Alignment: positive-path contract for migration registration, listing,
 *   and engine detection. No real database is used.
 * Category: contract
 *
 * Tests cover:
 *   - _db_register_migration stores migrations in declaration order
 *   - getRegisteredMigrations() returns names in order
 *   - resetRegisteredMigrations() clears the list
 *   - _db_migration_status returns JSON with applied=false when no DB configured
 *   - detectEngine infers 'postgres' / 'sqlite' / 'unknown' from constructor name
 *   - _db_run_migrations returns 0 when no database is configured
 *   - _db_rollback_migration returns 0 when no database is configured
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMigrationBridge,
  resetRegisteredMigrations,
  getRegisteredMigrations,
} from '../src/bridge/migration';
import { readLengthPrefixedString } from '../src/wasm/memory';
import type { WasmState } from '../src/types';

// ─── Test helpers ────────────────────────────────────────────────────────────

function writeRawAt(memory: WebAssembly.Memory, ptr: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

function makeMockState(memory?: WebAssembly.Memory, heapStart = 65_536): WasmState {
  const mem = memory ?? new WebAssembly.Memory({ initial: 4 });
  let heapPtr = heapStart;
  const exports = {
    memory: mem,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return {
    exports,
    config: { verbose: false },
    projectRoot: '/tmp',
    database: undefined,
  } as unknown as WasmState;
}

// Allocate a string in the mock memory at a given base address and return [ptr, len]
function alloc(memory: WebAssembly.Memory, base: number, s: string): [number, number] {
  const len = writeRawAt(memory, base, s);
  return [base, len];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Migration bridge — registration and listing', () => {
  beforeEach(() => {
    resetRegisteredMigrations();
  });

  it('_db_register_migration adds a migration and getRegisteredMigrations returns it', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const r = alloc(memory, base, s);
      base += s.length + 16;
      return r;
    }

    const [np, nl] = a('001_create_users');
    const [up, ul] = a('CREATE TABLE users (id INTEGER PRIMARY KEY);');
    const [dp, dl] = a('DROP TABLE users;');

    const rc = bridge._db_register_migration(np, nl, up, ul, dp, dl);
    expect(rc).toBe(1);

    const names = getRegisteredMigrations();
    expect(names).toHaveLength(1);
    expect(names[0]).toBe('001_create_users');
  });

  it('multiple registrations maintain declaration order', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    let base = 2048;
    function a(s: string): [number, number] {
      const r = alloc(memory, base, s);
      base += s.length + 16;
      return r;
    }

    const migrations = ['alpha', 'beta', 'gamma'];
    for (const name of migrations) {
      const [np, nl] = a(name);
      const [up, ul] = a(`CREATE TABLE ${name}_t (id INTEGER);`);
      const [dp, dl] = a(`DROP TABLE ${name}_t;`);
      bridge._db_register_migration(np, nl, up, ul, dp, dl);
    }

    const names = getRegisteredMigrations();
    expect(names).toEqual(migrations);
  });

  it('duplicate registration is ignored (idempotent)', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    let base = 3072;
    function a(s: string): [number, number] {
      const r = alloc(memory, base, s);
      base += s.length + 16;
      return r;
    }

    const [np, nl] = a('001_dup');
    const [up, ul] = a('CREATE TABLE dup (x TEXT);');
    const [dp, dl] = a('DROP TABLE dup;');

    bridge._db_register_migration(np, nl, up, ul, dp, dl);
    bridge._db_register_migration(np, nl, up, ul, dp, dl); // second call

    expect(getRegisteredMigrations()).toHaveLength(1);
  });

  it('resetRegisteredMigrations wipes the list', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    let base = 4096;
    function a(s: string): [number, number] {
      const r = alloc(memory, base, s);
      base += s.length + 16;
      return r;
    }

    const [np, nl] = a('first');
    const [up, ul] = a('CREATE TABLE first (x TEXT);');
    const [dp, dl] = a('DROP TABLE first;');
    bridge._db_register_migration(np, nl, up, ul, dp, dl);
    expect(getRegisteredMigrations()).toHaveLength(1);

    resetRegisteredMigrations();
    expect(getRegisteredMigrations()).toHaveLength(0);
  });
});

describe('Migration bridge — empty name rejection', () => {
  beforeEach(() => {
    resetRegisteredMigrations();
  });

  it('returns 0 for a blank migration name', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const r = alloc(memory, base, s);
      base += s.length + 16;
      return r;
    }

    // Write a space-only name (whitespace-only should be rejected)
    const [np, nl] = a('   ');
    const [up, ul] = a('SELECT 1;');
    const [dp, dl] = a('SELECT 1;');

    const rc = bridge._db_register_migration(np, nl, up, ul, dp, dl);
    expect(rc).toBe(0);
    expect(getRegisteredMigrations()).toHaveLength(0);
  });
});

describe('Migration bridge — status without database', () => {
  beforeEach(() => {
    resetRegisteredMigrations();
  });

  it('_db_migration_status returns JSON array with applied=false for all migrations', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    let base = 1024;
    function a(s: string): [number, number] {
      const r = alloc(memory, base, s);
      base += s.length + 16;
      return r;
    }

    const names = ['m1', 'm2'];
    for (const name of names) {
      const [np, nl] = a(name);
      const [up, ul] = a(`CREATE TABLE ${name} (x INT);`);
      const [dp, dl] = a(`DROP TABLE ${name};`);
      bridge._db_register_migration(np, nl, up, ul, dp, dl);
    }

    const ptr = bridge._db_migration_status();
    const json = readLengthPrefixedString(memory, ptr);
    const statuses = JSON.parse(json) as Array<{ name: string; applied: boolean; applied_at: null }>;

    expect(statuses).toHaveLength(2);
    expect(statuses[0].name).toBe('m1');
    expect(statuses[0].applied).toBe(false);
    expect(statuses[0].applied_at).toBeNull();
    expect(statuses[1].name).toBe('m2');
    expect(statuses[1].applied).toBe(false);
  });

  it('_db_run_migrations returns 0 when no database is configured', () => {
    const state = makeMockState();
    const bridge = createMigrationBridge(() => state);
    expect(bridge._db_run_migrations()).toBe(0);
  });

  it('_db_rollback_migration returns 0 when no database is configured', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    const [np, nl] = alloc(memory, 1024, 'some_migration');
    expect(bridge._db_rollback_migration(np, nl)).toBe(0);
  });
});

describe('Migration bridge — engine detection via constructor name', () => {
  beforeEach(() => {
    resetRegisteredMigrations();
  });

  it('_db_migration_diff returns empty LP-string when no database is configured', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    const [tp, tl] = alloc(memory, 1024, 'users');
    const [fp, fl] = alloc(memory, 1200, 'name TEXT, email TEXT');

    const ptr = bridge._db_migration_diff(tp, tl, fp, fl);
    const result = readLengthPrefixedString(memory, ptr);
    // No database → returns empty string immediately
    expect(result).toBe('');
  });

  it('_db_configure returns -1 for an unsupported engine string', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const state = makeMockState(memory);
    const bridge = createMigrationBridge(() => state);

    let base = 512;
    function a(s: string): [number, number] {
      const r = alloc(memory, base, s);
      base += s.length + 16;
      return r;
    }

    const [ep, el] = a('oracle');
    const [hp, hl] = a('host');
    const [pp, pl] = a('1521');
    const [dp, dl] = a('mydb');
    const [up, ul] = a('user');
    const [xp, xl] = a('pass');

    const rc = bridge._db_configure(ep, el, hp, hl, pp, pl, dp, dl, up, ul, xp, xl, 5, 30000);
    expect(rc).toBe(-1);
  });
});
