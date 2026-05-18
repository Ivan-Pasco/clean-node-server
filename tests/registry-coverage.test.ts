/**
 * Registry Coverage Test — Bridge vs function-registry.toml
 *
 * Verifies that every canonical name declared in the shared function-registry.toml
 * is present in the env object built by createBridgeImports(). Prevents silent
 * LinkError regressions when a new bridge function is added to the registry but
 * not implemented in the bridge.
 *
 * This test only runs when function-registry.toml is reachable (monorepo context).
 * It is skipped silently in standalone npm installs.
 *
 * Aliases (dot-notation names like db.query) are no longer checked here.
 * The compiler (v0.30.123+) emits only canonical _namespace_fn import names,
 * so the host only needs to register canonical names.
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

  it('auto-alias derived forms of _* bridge functions are NOT in env (compiler v0.30.123+ emits canonical only)', () => {
    // The compiler (v0.30.123+) no longer emits dot-notation aliases for bridge functions.
    // The auto-alias derivation rule: _namespace_fn → namespace.fn (strip _, replace first _ with .)
    // These derived dot-notation forms must NOT be separate entries in env — they were
    // only needed when the compiler dual-emitted both forms.
    //
    // Note: dot-notation names that the compiler emits as PRIMARY built-in method imports
    // (e.g. string.concat, math.sin, list.*) are still required and correctly registered.
    // This test only guards against re-introduction of the now-removed auto-alias loop.
    const unexpectedDerived: string[] = [];
    for (const entry of entries) {
      if (entry.module !== 'env') continue;
      // Only check canonical names that start with _ (bridge functions subject to auto-alias)
      if (!entry.name.startsWith('_') || entry.name.startsWith('__')) continue;
      const stripped = entry.name.slice(1);
      const dotIdx = stripped.indexOf('_');
      if (dotIdx === -1) continue;
      const derivedDotKey = `${stripped.slice(0, dotIdx)}.${stripped.slice(dotIdx + 1)}`;
      if (derivedDotKey in env) {
        unexpectedDerived.push(`${derivedDotKey} (derived from ${entry.name})`);
      }
    }
    expect(
      unexpectedDerived,
      `Auto-alias derived dot-notation forms found in env — auto-alias loop was re-added: ${unexpectedDerived.join(', ')}`
    ).toHaveLength(0);
  });
});
