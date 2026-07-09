#!/usr/bin/env node
// Layer 2 canary driver — instantiates one canary WASM against the real
// clean-node-server bridge imports and invokes _start.
//
// Invoked by scripts/run_canaries.mjs, one child process per canary.
//
// Contract:
//   argv[2] — path to the canary .wasm
//   stdout   — whatever the WASM writes via the console bridge
//   stderr   — driver diagnostics (not diffed)
//   exit 0   — start() ran without throwing
//   exit !=0 — LinkError, trap, or any other host-side failure
//
// The driver deliberately uses the compiled `dist/` bridge (not the .ts
// sources) so it exercises the exact code path a real request goes through.

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const REPO_ROOT = resolve(__dirname, '..');
const bridgeIndex = require(resolve(REPO_ROOT, 'dist', 'bridge', 'index.js'));
const stateModule = require(resolve(REPO_ROOT, 'dist', 'wasm', 'state.js'));
const sessionStoreModule = require(resolve(REPO_ROOT, 'dist', 'session', 'store.js'));

const { createBridgeImports } = bridgeIndex;
const { createWasmState } = stateModule;
const { InMemorySessionStore } = sessionStoreModule;

// Canaries write to /tmp/clean_canary_*.txt. The file bridge is sandboxed
// to sandboxRoot (default process.cwd()); expand it to /tmp so the file
// canary can round-trip. Same posture as the real host running with
// --sandbox /tmp for a file-heavy workload.
const fileBridgeModule = require(resolve(REPO_ROOT, 'dist', 'bridge', 'file.js'));
fileBridgeModule.setSandboxRoot('/tmp');

async function main() {
	const wasmPath = process.argv[2];
	if (!wasmPath) {
		console.error('canary_driver: missing wasm path argument');
		process.exit(2);
	}

	const bytes = new Uint8Array(await readFile(wasmPath));
	const module = await WebAssembly.compile(bytes.buffer);

	const config = {
		port: 0,
		host: '127.0.0.1',
		verbose: false,
		sessionSecret: 'canary-session-secret',
		jwtSecret: 'canary-jwt-secret',
		rateLimitMax: 0,
		rateLimitWindowMs: 60000,
		pgPoolSize: 2,
	};
	const sessionStore = new InMemorySessionStore();

	let state = null;
	const imports = createBridgeImports(() => {
		if (!state) throw new Error('canary_driver: state not initialized');
		return state;
	});

	let instance;
	try {
		instance = await WebAssembly.instantiate(module, imports);
	} catch (err) {
		console.error(`canary_driver: instantiate failed: ${err && err.message ? err.message : err}`);
		if (err && err.stack) console.error(err.stack);
		process.exit(3);
	}

	// Route registry stays empty for canaries — the canaries whose namespace is
	// http_server/router only register bridge imports; they never actually
	// receive requests during _start.
	state = createWasmState(instance, config, sessionStore, [], undefined, undefined);

	// Fire _start (or start) exactly the way the real host does after route
	// discovery. Most canaries print via _start and return.
	try {
		const exp = instance.exports;
		if (typeof exp._start === 'function') {
			exp._start();
		} else if (typeof exp.start === 'function') {
			exp.start();
		} else {
			console.error('canary_driver: WASM has no _start or start export');
			process.exit(4);
		}
	} catch (err) {
		console.error(`canary_driver: _start threw: ${err && err.message ? err.message : err}`);
		if (err && err.stack) console.error(err.stack);
		process.exit(5);
	}

	// Bridges may install timers / open handles (session store, http worker,
	// db pool). Flush stdio and exit explicitly so the driver process doesn't
	// linger past the WASM's actual work.
	await new Promise((r) => process.stdout.write('', r));
	await new Promise((r) => process.stderr.write('', r));
	process.exit(0);
}

main().catch((err) => {
	console.error(`canary_driver: unhandled: ${err && err.stack ? err.stack : err}`);
	process.exit(6);
});
