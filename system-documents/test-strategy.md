# Clean Node Server — Test Strategy

Last reviewed: 2026-07-12

This document defines what we test, at which stage, and what the CI/local
hook gates enforce. It is the single source of truth for the test strategy —
if you change how tests are organized, update this file in the same commit.

## Goals

1. **Correctness at the WASM ↔ Node boundary.** Every bridge function the
   compiler emits as an import must exist in the host with the exact ABI it
   expects. A LinkError in production is a category-A failure.
2. **Regression retention.** Every reported/fixed bug earns a permanent
   test with the fingerprint in the filename or `describe` block. Regressions
   surface immediately, not through user reports.
3. **Fast feedback.** Local hooks stay under 30 seconds. CI stays under
   3 minutes on the mainline path.
4. **No placeholder theatre.** Skipped tests, empty test bodies, `TODO`
   markers in test files, and untested bridge modules are policy violations.

## Test tiers

| Tier | Purpose | Where it runs | Target time |
|---|---|---|---|
| **0. Policy** | Static scan for placeholders, skipped tests, bridge coverage gaps | pre-commit, pre-push, CI | < 1 s |
| **1. Unit** | Pure logic — router, locale, memory helpers, list/array/math/console/mcp bridges | pre-commit, pre-push, CI | < 5 s |
| **2. Contract + regression** | Mocked WASM state exercising real bridge behaviour (file I/O via tmpdir, mocked DB drivers, ABI regression pinning) | pre-push, CI | < 30 s |
| **3. Integration** | Real DB drivers, real HTTP server boot, end-to-end request flow | CI PR + nightly (not local) | < 2 min |
| **4. Canaries** | Cross-repo compiler-compatibility WASM run-through (existing `scripts/canary_driver.mjs`) | Nightly CI (`nightly-canaries.yml`) | ~ 10 min |

Tier 3 (`tests/integration/**`) is the placeholder for future end-to-end
tests. It is excluded from the default `test:run` and only executes when
explicitly invoked via `npm run test:integration`.

## What each tier owns

### Tier 0 — Policy guard

Script: `scripts/check-test-policy.mjs`.

Enforces:

1. **No unjustified skips.** `it.skip`, `describe.skip`, `test.skip`, `.only`,
   `xit`, `xdescribe`. A skip is allowed only when the line — or the line
   immediately above it — carries the comment
   `// policy-allow-skip: <reason>`. This forces every skip to name why the
   test can't run (typically an environment guard).
2. **No placeholders.** `TODO`, `FIXME`, `XXX`, `PLACEHOLDER` anywhere in a
   test file's code (comments starting with `//` or ` * ` are allowed).
3. **No no-op assertions.** `expect(true).toBe(true)`, `expect(1).toBe(1)`.
4. **No empty test bodies.** `it('...', () => {})`.
5. **Every test file has at least one `expect(`.**
6. **Every bridge module is imported by at least one test file.**
   Exemptions live in `BRIDGE_TEST_EXEMPT` inside the script (pure infra:
   `helpers.ts`, `canvas-stubs.ts`, worker glue).

Runs in every hook and every CI job.

### Tier 1 — Unit

Files listed explicitly in `package.json → scripts.test:unit`. These have
no I/O, no filesystem, no worker threads. Fast enough to run on every
commit.

Currently:
- `router.test.ts` — route matching, HEAD fallback, param extraction
- `locale.test.ts` — CLDR plural selection, formatNumber/Currency/Date
- `memory.test.ts` — LP-string read/write, OOB guards
- `int64-to-string.test.ts` — i64 encoding
- `math-bridge.test.ts`, `list-bridge.test.ts`, `array-bridge.test.ts`,
  `console-bridge.test.ts`, `mcp-bridge.test.ts`

### Tier 2 — Contract + regression

Everything else in `tests/*.test.ts`. Mocked WASM state, mocked DB drivers,
tmpdir-backed filesystem tests, real SharedArrayBuffer workers.

Naming conventions:
- `<name>-bridge.test.ts` — contract test for a specific bridge module.
- `<bug-id>-<short-description>.test.ts` — regression test (e.g.
  `nsr002-heap-ptr-overlap.test.ts`).

### Tier 3 — Integration

Location: `tests/integration/**/*.test.ts` (currently empty — reserved
for future work: MySQL/Postgres live drivers, Redis session store, HTTP
server bootstrap through Express, full request-lifecycle).

Excluded from `test:run` by default. Runs only under `test:integration`
or the CI integration job.

### Tier 4 — Canaries

Existing, unchanged: `.github/workflows/nightly-canaries.yml` +
`scripts/canary_driver.mjs`. Runs the compiler-built corpus against
`dist/` to catch cross-version breakage.

## Hook wiring

| Hook | Runs |
|---|---|
| **pre-commit** (`.githooks/pre-commit`) | Tier 0 + Tier 1 (Tier 1 only when `src/`, `tests/`, or the policy/vitest config actually has staged changes) |
| **pre-push** (`.githooks/pre-push`) | Tier 0 + Tier 1 + Tier 2 (`test:contract`) |
| **CI PR** (`.github/workflows/publish.yml`) | Tier 0 (`policy` job) → parity → full `test:run` (Tier 1 + Tier 2). `publish` depends on all three. |
| **CI nightly** (`.github/workflows/nightly-canaries.yml`) | Tier 4 canaries (unchanged) |

Hooks live in `.githooks/` and are activated by `npm run hooks:install`
(which is triggered automatically by `npm install` via the `prepare`
script). Contributors do not need to run any manual step.

Escape hatches: `git commit --no-verify` and `git push --no-verify` bypass
the hooks. Use only when the failure is clearly unrelated to what you're
committing — CI will still catch it.

## Project policies

These policies are enforced by the Tier-0 guard and by review; they are
not optional:

1. **Every new bridge module must ship with a test file that imports it.**
   The policy script fails the build otherwise. If the module is pure infra
   (worker glue, wrapper, no observable behaviour), add it to
   `BRIDGE_TEST_EXEMPT` in `scripts/check-test-policy.mjs` in the same PR
   with a comment explaining why.
2. **A failing test is never "fixed" by editing the test.** See
   `~/.claude/CLAUDE.md`: "when a test fails the solution never is to
   change the test so it passes." Fix the code. The only exception is a
   test that contradicts the language spec — then fix the test and cite
   the EBNF line.
3. **Regression tests never expire.** Once written, they stay until the
   fingerprinted bug is deprecated at the language level. Renaming or
   deleting a regression test requires a PR-level justification.
4. **Skipped tests must carry `// policy-allow-skip: <reason>`.** Any
   skip without a justification comment is a policy violation and blocks
   the commit.
5. **No `TODO`/`FIXME`/placeholder markers in test files.** Testing gaps
   go in `TASKS.md`, not inside the test file. Empty test bodies
   (`it('...', () => {})`) are treated as intentional-but-uncalled-out
   stubs and are rejected.
6. **New bridge functions must land with tests in the same PR.** Reviewers
   should reject "test to follow" PRs. The Tier-0 guard covers module-level
   coverage; function-level coverage is a review responsibility.

## Adding a new bridge module

1. Create `src/bridge/<name>.ts` exporting `create<Name>Bridge(getState)`.
2. Register the canonical `_namespace_fn` name(s) in `src/bridge/index.ts`.
3. Create `tests/<name>-bridge.test.ts` following the conventions in
   `tests/file-bridge.test.ts` (mock `WasmState`, `writeRawAt`,
   `readLengthPrefixedString`).
4. Run `npm run test:policy` — must pass.
5. Run `npm run test:contract` — new suite must pass.
6. Update `foundation/platform-architecture/HOST_BRIDGE.md` and
   `foundation/platform-architecture/function-registry.toml` (parity
   check will otherwise fail in CI).

## Adding a new regression test

Naming: `<component>-<short-symptom>.test.ts` or
`<bug-id>-<description>.test.ts`. Example: `nsr002-string-concat-bytes.test.ts`.

Comment header must include:
- Fingerprint or bug ID
- One-line symptom
- Which fix commit landed the resolution
- Which line of the spec / registry the test pins

## Coverage philosophy

We do not track line coverage as a target. Instead:
- Every bridge module has at least one test file (Tier-0 enforced).
- Every reported bug has at least one regression test (review-enforced).
- Every ABI convention (LP-pointer vs raw-ptr+len, ANY-in/ANY-out) has an
  explicit contract test (`bridge-abi.test.ts`, `json-get-bridge.test.ts`,
  `int64-to-string.test.ts`).

Line coverage reports (`test:run --coverage`) are available for
investigative use but are not a CI gate. Enforcing line coverage tends
to encourage assertion-light tests that pass without proving anything.

## Emergency runbook

- **CI test job red on main.** Run `npm run test:contract` locally, isolate
  the failing file, revert the offending commit or land a fix. Do not
  ignore the alert; regressions here mean the ABI/contract is broken.
- **Policy guard red on a PR.** Read the output — it names the file and
  the violation. Either fix the test file (add justification, remove
  placeholder) or create the missing bridge test.
- **Hooks feel slow.** Profile with `time npm run test:precommit`. If
  a Tier-1 file has grown to depend on I/O, move it to Tier 2 by
  removing it from `test:unit` in `package.json`.

## Files touched by this strategy

- `scripts/check-test-policy.mjs` — Tier-0 guard
- `vitest.config.ts` — Tier boundary (integration exclusion)
- `package.json → scripts` — Tier scripts (`test:unit`, `test:contract`,
  `test:integration`, `test:precommit`, `test:prepush`, `test:ci`,
  `test:policy`, `hooks:install`)
- `.githooks/pre-commit`, `.githooks/pre-push` — local gates
- `.github/workflows/publish.yml` — CI gates (`policy` job added,
  `publish` depends on all three)
- `system-documents/test-strategy.md` — this file
