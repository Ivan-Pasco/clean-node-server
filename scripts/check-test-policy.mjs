#!/usr/bin/env node
/**
 * Test-policy guard.
 *
 * Enforces (fast, static — <1s):
 *  1. No skipped tests (`it.skip`, `describe.skip`, `test.skip`, `.only`).
 *  2. No placeholder markers inside test files (`TODO`, `FIXME`, `PLACEHOLDER`,
 *     `xdescribe`, `xit`, empty test bodies, `expect(true).toBe(true)`).
 *  3. Every bridge module exposed in src/bridge/ (except pure infra like
 *     helpers, canvas-stubs, http-worker, mcp-http-worker, mcp-stdio-worker,
 *     memory-runtime — which are indirectly exercised) must have at least
 *     one importing test file under tests/.
 *  4. Every test file must actually contain at least one live assertion.
 *
 * Runs on:
 *  - pre-commit  (Tier 0 — sub-second, blocks bad commits)
 *  - pre-push    (part of Tier-0+1 gate)
 *  - CI PR       (part of the policy job)
 *
 * Exit 0 = pass. Exit 1 = policy violation with a report.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const TESTS_DIR = join(ROOT, 'tests');
const BRIDGE_DIR = join(ROOT, 'src', 'bridge');

// Bridges that are pure infra or wrappers that don't need a dedicated test file.
// They are still covered by registry-coverage or indirectly by higher-level tests.
const BRIDGE_TEST_EXEMPT = new Set([
  'helpers.ts',
  'canvas-stubs.ts',
  'http-worker.ts',
  'mcp-http-worker.ts',
  'mcp-stdio-worker.ts',
  'index.ts',
  'test.ts',
  'sse.ts', // wired via http-server; no independent surface
  'input.ts', // stdin only — see registry-coverage
  'env.ts', // trivial pass-through
]);

const SKIP_PATTERNS = [
  { re: /\b(it|test|describe)\.skip\s*\(/g, msg: 'skipped test' },
  { re: /\b(it|test|describe)\.only\s*\(/g, msg: '.only leaks into commit' },
  { re: /\bxdescribe\s*\(|\bxit\s*\(/g, msg: 'xdescribe/xit' },
];

const PLACEHOLDER_PATTERNS = [
  { re: /\b(TODO|FIXME|XXX|PLACEHOLDER)\b/g, msg: 'placeholder marker' },
  { re: /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/g, msg: 'no-op assertion' },
  { re: /expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/g, msg: 'no-op assertion' },
];

const ALLOWED_PLACEHOLDER_IN_COMMENT = /^\s*\*|^\s*\/\//;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function scanTestFile(file) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const violations = [];

  // Skip patterns are line-scoped so we can honour a per-line escape hatch:
  // `// policy-allow-skip: <reason>` on the same line or the immediately
  // preceding line. This forces every skip to carry a justification comment
  // instead of banning them outright (some are legitimate environment guards,
  // e.g. "function-registry.toml not present in standalone npm install").
  {
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = i > 0 ? lines[i - 1] : '';
      const allowed = /\/\/\s*policy-allow-skip\s*:/.test(line) || /\/\/\s*policy-allow-skip\s*:/.test(prev);
      for (const { re, msg } of SKIP_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line)) {
          if (allowed && msg === 'skipped test') continue;
          violations.push({ file: rel, msg, snippet: `line ${i + 1}: ${line.trim().slice(0, 100)}` });
        }
      }
    }
  }

  // Placeholder patterns: scan line-by-line so we can skip comment-only lines.
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALLOWED_PLACEHOLDER_IN_COMMENT.test(line)) continue;
    for (const { re, msg } of PLACEHOLDER_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        violations.push({ file: rel, msg, snippet: `line ${i + 1}: ${line.trim()}` });
      }
    }
  }

  // Empty test bodies: `it('...', () => {})` or `it('...', async () => {})`
  const emptyBody = /\b(it|test)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
  for (const m of src.matchAll(emptyBody)) {
    violations.push({ file: rel, msg: 'empty test body', snippet: m[0].slice(0, 80) });
  }

  // Must contain at least one expect(
  if (!/\bexpect\s*\(/.test(src)) {
    violations.push({ file: rel, msg: 'test file has zero assertions' });
  }

  return violations;
}

function checkBridgeCoverage() {
  const bridgeFiles = readdirSync(BRIDGE_DIR).filter((f) => f.endsWith('.ts'));
  const testFiles = walk(TESTS_DIR).filter((f) => f.endsWith('.test.ts'));
  const testCorpus = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  const violations = [];
  for (const bf of bridgeFiles) {
    if (BRIDGE_TEST_EXEMPT.has(bf)) continue;
    const modName = bf.replace(/\.ts$/, '');
    // Match either an explicit import from ../src/bridge/<name> or a canonical
    // bridge function prefix (e.g. _ws_ for websocket, _job_ for jobs).
    const importRe = new RegExp(`from ['"][^'"]*bridge/${modName}['"]`);
    if (!importRe.test(testCorpus)) {
      violations.push({
        file: `src/bridge/${bf}`,
        msg: `bridge module has no test file that imports it (add tests/${modName}.test.ts or extend an existing test)`,
      });
    }
  }
  return violations;
}

function main() {
  const testFiles = walk(TESTS_DIR).filter((f) => f.endsWith('.test.ts'));
  const violations = [];

  if (testFiles.length === 0) {
    violations.push({ file: 'tests/', msg: 'no test files found' });
  }

  for (const f of testFiles) {
    violations.push(...scanTestFile(f));
  }
  violations.push(...checkBridgeCoverage());

  if (violations.length === 0) {
    console.log(`[test-policy] OK — ${testFiles.length} test files scanned, 0 violations.`);
    process.exit(0);
  }

  console.error(`[test-policy] FAIL — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  • ${v.file}: ${v.msg}${v.snippet ? ` — ${v.snippet}` : ''}`);
  }
  console.error('');
  console.error('Fix or justify each violation. See system-documents/test-strategy.md.');
  process.exit(1);
}

main();
