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
  hosts: string[];
}

function parseRegistry(toml: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const blocks = toml.split(/^\[\[functions\]\]/m);
  for (const block of blocks.slice(1)) {
    const nameMatch = block.match(/^name\s*=\s*"([^"]+)"/m);
    const aliasesMatch = block.match(/^aliases\s*=\s*\[([^\]]*)\]/ms);
    const moduleMatch = block.match(/^module\s*=\s*"([^"]+)"/m);
    const hostsMatch = block.match(/^hosts\s*=\s*\[([^\]]*)\]/ms);
    if (!nameMatch) continue;
    const aliases = aliasesMatch
      ? [...aliasesMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : [];
    const module = moduleMatch ? moduleMatch[1] : 'env';
    const hosts = hostsMatch
      ? [...hostsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : [];
    entries.push({ name: nameMatch[1], aliases, module, hosts });
  }
  return entries;
}

/**
 * True if the registry says this entry must be implemented by clean-node-server.
 *
 * Entries with `hosts = ["all"]` apply to every host. Entries with `hosts =
 * ["server"]` apply to both clean-server (Rust) and clean-node-server (this
 * project) — apps don't choose between server implementations when calling a
 * bridge function. Entries with `hosts = ["browser"]` (or other restricted
 * lists not including server) must NOT be checked against the node-server
 * bridge — they're implemented in the browser runtime JS shipped with the
 * framework plugins, not here. Entries with no `hosts` field are unenforced
 * and skipped to avoid false positives on legacy registry rows.
 *
 * See foundation/platform-architecture/function-registry.toml and
 * foundation/management/scripts/check_host_parity.py for the canonical rule.
 */
function requiredForNodeServer(hosts: string[]): boolean {
  if (hosts.length === 0) return false;
  return hosts.includes('all') || hosts.includes('server') || hosts.includes('node-server');
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

  it('every canonical name the registry requires of node-server is registered', () => {
    const missing: string[] = [];
    for (const entry of entries) {
      // memory_runtime module functions live in a separate WASM module; skip them
      if (entry.module !== 'env') continue;
      // Browser-only / unenforced entries are not this host's responsibility.
      if (!requiredForNodeServer(entry.hosts)) continue;
      // An alias registration satisfies the coverage check — the bridge only
      // needs one binding under any of the declared names for WASM imports to
      // resolve. Mirrors check_host_parity.py's MISSING rule.
      if (entry.name in env) continue;
      if (entry.aliases.some((a) => a in env)) continue;
      missing.push(entry.name);
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
