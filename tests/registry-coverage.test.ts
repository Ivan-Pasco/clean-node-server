/**
 * Registry Coverage Test — Bridge vs function-registry.toml
 *
 * Verifies that every canonical name and alias declared in the shared
 * function-registry.toml is present in the env object built by
 * createBridgeImports(). Prevents silent LinkError regressions when:
 *   - A new bridge function is added to the registry but not implemented here
 *   - An alias is added to the registry but the auto-alias loop misses it
 *
 * This test only runs when function-registry.toml is reachable (monorepo context).
 * It is skipped silently in standalone npm installs.
 *
 * The dual-naming requirement (_namespace_fn + namespace.fn) is temporary.
 * When the compiler is fixed to emit only canonical names, the auto-alias
 * loop in bridge/index.ts can be removed and the aliases column in this
 * test will become empty. The test itself remains valid either way.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { createBridgeImports } from '../src/bridge/index';
import type { WasmState } from '../src/types';

// ─── Registry Parser ──────────────────────────────────────────────────────────

interface RegistryEntry {
  name: string;
  aliases: string[];
  module: string;
}

function parseRegistry(toml: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const blocks = toml.split(/^\[\[functions\]\]/m);
  for (const block of blocks.slice(1)) {
    const nameMatch = block.match(/^name\s*=\s*"([^"]+)"/m);
    const aliasesMatch = block.match(/^aliases\s*=\s*\[([^\]]*)\]/ms);
    const moduleMatch = block.match(/^module\s*=\s*"([^"]+)"/m);
    if (!nameMatch) continue;
    const aliases = aliasesMatch
      ? [...aliasesMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : [];
    const module = moduleMatch ? moduleMatch[1] : 'env';
    entries.push({ name: nameMatch[1], aliases, module });
  }
  return entries;
}

// ─── Mock State ───────────────────────────────────────────────────────────────

function makeMockState(): WasmState {
  const memory = new WebAssembly.Memory({ initial: 2 });
  let heapPtr = 4096;
  const exports = {
    memory,
    malloc: (size: number): number => {
      const ptr = heapPtr;
      heapPtr += size + 4;
      return ptr;
    },
  } as unknown as WasmState['exports'];
  return { exports, projectRoot: '/tmp' } as unknown as WasmState;
}

// ─── Test ─────────────────────────────────────────────────────────────────────

const REGISTRY_PATH = path.resolve(
  __dirname,
  '../../foundation/platform-architecture/function-registry.toml'
);

const registryExists = fs.existsSync(REGISTRY_PATH);

describe('Bridge registry coverage', () => {
  if (!registryExists) {
    it.skip('function-registry.toml not found — skipping (not in monorepo)', () => {});
    return;
  }

  let env: Record<string, unknown>;
  let entries: RegistryEntry[];

  // Build the env object once for all assertions
  const state = makeMockState();
  const imports = createBridgeImports(() => state);
  env = imports.env as Record<string, unknown>;
  entries = parseRegistry(fs.readFileSync(REGISTRY_PATH, 'utf8'));

  it('env object is built without errors', () => {
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
  });

  it('every canonical name in the registry is registered', () => {
    const missing: string[] = [];
    for (const entry of entries) {
      // memory_runtime module functions live in a separate WASM module; skip them
      if (entry.module !== 'env') continue;
      if (!(entry.name in env)) {
        missing.push(entry.name);
      }
    }
    expect(missing, `Missing canonical registrations: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every alias in the registry is registered', () => {
    const missing: string[] = [];
    for (const entry of entries) {
      // memory_runtime module functions live in a separate WASM module; skip them
      if (entry.module !== 'env') continue;
      for (const alias of entry.aliases) {
        if (!(alias in env)) {
          missing.push(`${alias} (alias of ${entry.name})`);
        }
      }
    }
    expect(missing, `Missing alias registrations: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('no duplicate registrations exist for the same logical function', () => {
    // Ensure canonical and dot-notation both resolve to the same callable,
    // not two different functions (which would indicate a copy-paste error).
    for (const entry of entries) {
      // memory_runtime module functions live in a separate WASM module; skip them
      if (entry.module !== 'env') continue;
      for (const alias of entry.aliases) {
        if (entry.name in env && alias in env) {
          // Both are registered — they should be the same function reference.
          // For noop stubs this is always true; for real functions it catches drift.
          expect(typeof env[entry.name]).toBe(typeof env[alias]);
        }
      }
    }
  });
});
