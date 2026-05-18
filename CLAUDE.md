# CLAUDE.md - Clean Node Server Development Guide

This file provides guidance when working with the Clean Node Server codebase.

## Project Overview

Clean Node Server provides a Node.js-based runtime for Clean Language WebAssembly applications.

## Important Constraints

- **NEVER** write any reference to AI assistants in any documents, git commits, or any part of the code
- **NEVER** mention AI tools in git commit messages or any part of the codebase

## Cross-Component Work Policy

**CRITICAL: AI Instance Separation of Concerns**

When working in this component and discovering errors, bugs, or required changes in **another component** (different folder in the Clean Language project), you must **NOT** directly fix or modify code in that other component.

Instead:

1. **Document the issue** by creating a prompt/task description
2. **Save the prompt** in a file that can be executed by the AI instance working in the correct folder
3. **Location for cross-component prompts**: Save prompts in `../foundation/management/cross-component-prompts/` at the project root

### Prompt Format for Cross-Component Issues

See [`foundation/management/cross-component-prompts/README.md`](../foundation/management/cross-component-prompts/README.md) for the required header format and filename prefix convention. Use the `node-server-` prefix for issues that originated here and need to be routed back; use the correct target prefix (e.g. `server-`, `compiler-`) for issues in other components.

### Why This Rule Exists

- Each component has its own context, dependencies, and testing requirements
- AI instances are optimized for their specific component's codebase
- Cross-component changes without proper context can introduce bugs
- This maintains clear boundaries and accountability
- Ensures changes are properly tested in the target component's environment

### What You CAN Do

- Read files from other components to understand interfaces
- Document compatibility issues found
- Create detailed prompts for the correct AI instance
- Update your component to work with existing interfaces

### What You MUST NOT Do

- Directly edit code in other components
- Make changes to other components' configuration files
- Modify shared resources without coordination
- Skip the prompt creation step for cross-component issues

## Documentation Sync Protocol

Facts about the language live in `foundation/spec/` (at the project root). Facts about the platform live in `foundation/platform-architecture/`. Do not duplicate them here — link to them instead.

**When you make a change in this component, update the corresponding spec file in the same commit:**

| Change type | Update required |
|-------------|-----------------|
| New or changed host bridge function | `foundation/platform-architecture/HOST_BRIDGE.md` + `function-registry.toml` |
| New or changed execution layer | `foundation/platform-architecture/EXECUTION_LAYERS.md` |

The spec files are the single source of truth. Component documentation explains implementation — it does not redefine language rules.

## Bridge Function Naming — Dual Registration Required

The compiler generates WASM imports in **both** `_namespace_fn` (underscore) and `namespace.fn` (dot-notation) styles. Both must be registered or the WASM linker throws a `LinkError` at instantiation.

`bridge/index.ts` handles this via an auto-alias loop at the end of `createBridgeImports()` — do not remove it. When adding new bridge functions that follow the `_namespace_fn` pattern, the loop covers them automatically. For functions without a leading `_` (e.g. HTTP client functions like `http_get`), add explicit dot-notation aliases manually if the compiler emits them.

See [`foundation/platform-architecture/HOST_BRIDGE.md § Dual Naming`](../foundation/platform-architecture/HOST_BRIDGE.md) for the full spec.
