# CLAUDE.md - Clean Node Server Development Guide

This file provides guidance when working with the Clean Node Server codebase.

## Project Overview

Clean Node Server provides a Node.js-based runtime for Clean Language WebAssembly applications.

## Important Constraints

- **NEVER** write any reference to AI assistants in any documents, git commits, or any part of the code
- **NEVER** mention AI tools in git commit messages or any part of the codebase

## Test Strategy (MANDATORY)

The full strategy lives in [`system-documents/test-strategy.md`](./system-documents/test-strategy.md).

Non-negotiables when working in this repo:

1. **Every new bridge module in `src/bridge/` must land with a test file
   under `tests/` that imports it in the same PR.** The Tier-0 policy
   guard (`scripts/check-test-policy.mjs`) fails the build otherwise.
2. **No skipped tests without `// policy-allow-skip: <reason>`, no
   `TODO`/`FIXME` markers in test files, no empty test bodies, no
   `expect(true).toBe(true)`.** These are policy violations.
3. **Never edit a test to make it pass.** Fix the code. Only exception is
   a test contradicting the spec — then fix the test and cite the EBNF.
4. **Regression tests are permanent.** Do not rename or delete a bug-ID
   test without a PR-level justification.
5. Local hooks run via `.githooks/` (activated by `npm run hooks:install`,
   auto-triggered by `npm install`'s `prepare` script). Do not bypass with
   `--no-verify` unless the failure is unrelated to what you're pushing.

Available npm scripts: `test:policy`, `test:unit`, `test:contract`,
`test:integration`, `test:precommit`, `test:prepush`, `test:ci`.

## Cross-Component Work Policy

**CRITICAL: You are a Team Developer AI.** When you discover something in another component, choose the correct channel based on what you found:

| What you found | Channel | Why |
|---|---|---|
| A **bug** (crash, wrong output, spec violation, regression) | **`report_error` MCP tool** — MANDATORY | Fingerprint dedup, occurrence tracking, automatic user notification on fix, visible on errors.cleanlanguage.dev |
| A **design proposal, directive change, schema/API request, architectural ask** | Markdown file in `../foundation/management/cross-component-prompts/` | Requires discussion, not auto-fix |

**Never** write a markdown file for something that is a bug. Bug reports in markdown are invisible to the dashboard, don't notify users when fixed, and can't be queried via `list_component_bugs`.

### What You CAN Do

- Read files from other components to understand interfaces
- Call `report_error` for bugs found in other components
- Write markdown prompts for design/architecture discussions
- Update your component to work with existing interfaces

### What You MUST NOT Do

- Directly edit code in other components
- Make changes to other components' configuration files
- Write a markdown file for something that is a bug — use `report_error` instead

See `../foundation/management/USER_TYPES_AND_ERROR_REPORTING.md` for the full policy.

## Documentation Sync Protocol

Facts about the language live in `foundation/spec/` (at the project root). Facts about the platform live in `foundation/platform-architecture/`. Do not duplicate them here — link to them instead.

**When you make a change in this component, update the corresponding spec file in the same commit:**

| Change type | Update required |
|-------------|-----------------|
| New or changed host bridge function | `foundation/platform-architecture/HOST_BRIDGE.md` + `function-registry.toml` |
| New or changed execution layer | `foundation/platform-architecture/EXECUTION_LAYERS.md` |

The spec files are the single source of truth. Component documentation explains implementation — it does not redefine language rules.

## Bridge Function Naming — Canonical Names Only (v0.30.123+)

The compiler (v0.30.123+) emits **only** the canonical `_namespace_fn` form for each bridge function import. Dot-notation aliases (`namespace.fn`) are no longer emitted as WASM imports.

When adding a new bridge function, register only the canonical `_namespace_fn` name in `bridge/index.ts`. The auto-alias loop that previously derived `namespace.fn` from `_namespace_fn` has been removed — do not re-add it.

Some dot-notation names ARE still required because the compiler emits them directly as built-in method imports (not bridge aliases):
- `string.concat`, `string.toUpperCase`, `string.toLowerCase`, `string.toNumber`, etc.
- `integer.toString`, `number.toString`, `boolean.toString`, `string.toInteger`, `string.toBoolean`
- `list.*`, `math.*`

These are explicitly registered in `bridge/index.ts` and must stay.

See [`foundation/platform-architecture/HOST_BRIDGE.md`](../foundation/platform-architecture/HOST_BRIDGE.md) and [`foundation/platform-architecture/function-registry.toml`](../foundation/platform-architecture/function-registry.toml) for the authoritative registry.

## Cross-component prompts

The team publishes cross-component prompts, change requests, and handoffs at https://errors.cleanlanguage.dev/prompts.

- `/team-prompt` publishes a prompt. Use it when this session discovered something a session in a **different** component must know before working: a required change there, a discovered contract, a blocker needing a decision from another maintainer, or a session-end handoff whose next reader is in a different repo.
- `/team-prompts-list` fetches open prompts addressed to this component (inferred from `$PWD`). Consider running it at session start if the user asks for status.

Do **not** use these skills for:
- Compiler/plugin/runtime bug reports — those go through `report_error` via the MCP server.
- Same-component notes — use `TASKS.md` or a session-handoff markdown file.
- Chat.

The API token lives at `~/.config/clean-errors/api_token` (mode 600). Team members without it get it from the team vault.
