#!/usr/bin/env node
// Layer 2 canary runner (node-server).
//
// Reads the compiler's canary corpus, compiles each node-server-applicable
// canary to WASM with the installed `cln`, instantiates the module in a
// child Node process against clean-node-server's real bridge imports,
// captures stdout, and diffs against the canary's expected block.
//
// See: umbrella prompt 7fb425cb-79ba-11f1-9586-da25a95a496b (Layer 2,
// node-server), child prompt 6ace888b-7a8d-11f1-9586-da25a95a496b.
//
// Fails LOUDLY on:
//   - LinkError at instantiation (missing bridge import)
//   - Runtime trap
//   - stdout diff
//   - Missing / uncompilable canary
//
// Usage:
//   node scripts/run_canaries.mjs                 # against sibling compiler checkout
//   CANARY_DIR=/path/to/canaries \
//     node scripts/run_canaries.mjs
//   node scripts/run_canaries.mjs --json          # machine-readable report
//   node scripts/run_canaries.mjs --filter=console
//   CANARY_KEEP=1 node scripts/run_canaries.mjs   # keep compiled artifacts

import { spawn } from 'node:child_process';
import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const DRIVER = join(__dirname, 'canary_driver.mjs');
const DIST_BRIDGE = join(REPO_ROOT, 'dist', 'bridge', 'index.js');

// Node-server runs the same host role as clean-server: it should exercise
// every Layer-2 portable canary AND every Layer-3 server canary. The only
// canaries filtered out are the ones that require a browser runtime.
const BROWSER_ONLY = new Set([
	'canvas',
	'api',    // frame.client — browser
	'ui',     // ui canary uses component: DSL which only runs in the browser
]);

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const filter = (args.find((a) => a.startsWith('--filter=')) || '').slice('--filter='.length);
const canaryDirOverride = process.env.CANARY_DIR;
const keepArtifacts = process.env.CANARY_KEEP === '1';

// ---------------------------------------------------------------------------
// Canary discovery + parsing

function parseCanaryHeader(source) {
	// Namespace: <name> [(Layer X, <hosts>)]
	// Only the first namespace token drives host-applicability filtering.
	const nsMatch = source.match(/^\/\/\s*Namespace:\s*([A-Za-z_][A-Za-z0-9_]*)/m);
	const namespace = nsMatch ? nsMatch[1].trim() : null;
	const layerMatch = source.match(/\(Layer\s+([^)]+)\)/);
	const layerLine = layerMatch ? layerMatch[1].trim() : '';

	// Expected output — contiguous "//   <line>" following "// Expected output:".
	const expected = [];
	const lines = source.split('\n');
	let inBlock = false;
	for (const raw of lines) {
		if (!inBlock) {
			if (/^\/\/\s*Expected output:/.test(raw)) {
				inBlock = true;
				continue;
			}
			continue;
		}
		const m = raw.match(/^\/\/(\s{2,})(.*)$/);
		if (m) {
			expected.push(m[2].replace(/\s+$/, ''));
		} else {
			break;
		}
	}
	return { namespace, layerLine, expected };
}

function isApplicable(namespace) {
	if (!namespace) return false;
	const primary = namespace.split(/[\s+]/)[0].toLowerCase();
	return !BROWSER_ONLY.has(primary);
}

async function discoverCanaries(canaryDir) {
	const entries = await readdir(canaryDir);
	const out = [];
	for (const name of entries) {
		if (extname(name) !== '.cln') continue;
		const full = join(canaryDir, name);
		const source = await readFile(full, 'utf8');
		const { namespace, layerLine, expected } = parseCanaryHeader(source);
		out.push({ file: full, name, namespace, layerLine, expected });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Compilation via installed `cln`

function runCmd(cmd, argv, opts = {}) {
	return new Promise((resolvePromise, reject) => {
		const proc = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => (stdout += d.toString()));
		proc.stderr.on('data', (d) => (stderr += d.toString()));
		proc.on('error', reject);
		proc.on('close', (code) => resolvePromise({ code, stdout, stderr }));
	});
}

async function compileCanary(canaryPath, outWasm) {
	const { code, stdout, stderr } = await runCmd('cln', ['compile', canaryPath, '-o', outWasm]);
	if (code !== 0) {
		throw new Error(
			`cln compile failed (exit ${code}) for ${canaryPath}\n` +
				`stdout:\n${stdout}\nstderr:\n${stderr}`
		);
	}
}

// ---------------------------------------------------------------------------
// Runner

function runDriver(wasmPath, timeoutMs = 15_000) {
	return new Promise((resolvePromise) => {
		const proc = spawn(process.execPath, [DRIVER, wasmPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env },
		});
		let stdout = '';
		let stderr = '';
		let done = false;
		const timer = setTimeout(() => {
			if (!done) {
				proc.kill('SIGKILL');
			}
		}, timeoutMs);
		proc.stdout.on('data', (d) => (stdout += d.toString()));
		proc.stderr.on('data', (d) => (stderr += d.toString()));
		proc.on('close', (code, signal) => {
			done = true;
			clearTimeout(timer);
			resolvePromise({ code, signal, stdout, stderr });
		});
	});
}

function classifyDriverFailure(driverStderr, driverStdout) {
	const combined = `${driverStderr}\n${driverStdout}`;
	if (/LinkError/.test(combined)) return 'linkerror';
	if (/CompileError/.test(combined)) return 'compileerror';
	if (/RuntimeError|unreachable executed|out of bounds/.test(combined)) return 'trap';
	return null;
}

async function runOne({ canary, runDir }) {
	const stem = canary.name.replace(/\.cln$/, '');
	const workDir = join(runDir, stem);
	await mkdir(workDir, { recursive: true });
	const wasmPath = join(workDir, 'canary.wasm');

	try {
		await compileCanary(canary.file, wasmPath);
	} catch (err) {
		return {
			canary: canary.name,
			namespace: canary.namespace,
			status: 'compile_error',
			error: err.message || String(err),
		};
	}

	const { code, signal, stdout, stderr } = await runDriver(wasmPath);

	if (!keepArtifacts) {
		try {
			await rm(workDir, { recursive: true, force: true });
		} catch (_) {
			// Best-effort cleanup.
		}
	}

	const actual = stdout.split('\n').map((l) => l.replace(/\s+$/, ''));
	// Trim a single trailing empty line — printl always emits a final \n.
	if (actual.length && actual[actual.length - 1] === '') actual.pop();

	const expected = canary.expected.map((l) => l.replace(/\s+$/, ''));
	const diff = diffLines(expected, actual);

	let status;
	if (signal) {
		status = 'trap';
	} else if (code !== 0) {
		status = classifyDriverFailure(stderr, stdout) || 'trap';
	} else if (diff.length === 0) {
		status = 'pass';
	} else {
		status = 'diff';
	}

	return {
		canary: canary.name,
		namespace: canary.namespace,
		status,
		expected,
		actual,
		diff,
		exitCode: code,
		signal,
		driverStderr: stderr,
	};
}

function diffLines(expected, actual) {
	const diffs = [];
	const max = Math.max(expected.length, actual.length);
	for (let i = 0; i < max; i++) {
		const e = expected[i];
		const a = actual[i];
		if (e === undefined) {
			diffs.push({ line: i + 1, expected: null, actual: a });
		} else if (a === undefined) {
			diffs.push({ line: i + 1, expected: e, actual: null });
		} else if (e !== a) {
			diffs.push({ line: i + 1, expected: e, actual: a });
		}
	}
	return diffs;
}

// ---------------------------------------------------------------------------
// Entry point

async function locateCanaryDir() {
	if (canaryDirOverride) {
		if (!existsSync(canaryDirOverride)) {
			throw new Error(`CANARY_DIR does not exist: ${canaryDirOverride}`);
		}
		return canaryDirOverride;
	}
	// Sibling checkout: ../clean-language-compiler/tests/cln/canaries
	const guesses = [
		resolve(REPO_ROOT, '..', 'clean-language-compiler', 'tests', 'cln', 'canaries'),
		resolve(REPO_ROOT, '..', '..', 'clean-language-compiler', 'tests', 'cln', 'canaries'),
	];
	for (const g of guesses) {
		if (existsSync(g)) return g;
	}
	throw new Error(
		'Could not locate canary corpus. Set CANARY_DIR to the path of ' +
			'clean-language-compiler/tests/cln/canaries.'
	);
}

async function main() {
	if (!existsSync(DIST_BRIDGE)) {
		console.error(
			`[canaries] dist bridge not found at ${DIST_BRIDGE}\n` +
				'         Run `npm run build` first.'
		);
		process.exit(2);
	}

	const canaryDir = await locateCanaryDir();
	if (!asJson) {
		console.error(`[canaries] corpus: ${canaryDir}`);
	}

	const all = await discoverCanaries(canaryDir);
	const applicable = all.filter((c) => isApplicable(c.namespace));
	const filtered = filter
		? applicable.filter((c) => c.namespace && c.namespace.toLowerCase().includes(filter.toLowerCase()))
		: applicable;

	if (filtered.length === 0) {
		console.error('[canaries] no applicable canaries after filtering');
		process.exit(2);
	}

	if (!asJson) {
		console.error(
			`[canaries] running ${filtered.length} canaries ` +
				`(skipped ${all.length - applicable.length} browser-only)`
		);
	}

	const runDir = join(REPO_ROOT, '.canary-run');
	await mkdir(runDir, { recursive: true });

	const results = [];
	for (const canary of filtered) {
		if (!asJson) {
			process.stderr.write(`  ${canary.name.padEnd(20)} `);
		}
		let result;
		try {
			result = await runOne({ canary, runDir });
		} catch (err) {
			result = {
				canary: canary.name,
				namespace: canary.namespace,
				status: 'error',
				error: err.message || String(err),
			};
		}
		results.push(result);
		if (!asJson) {
			const symbol =
				result.status === 'pass'
					? 'PASS'
					: result.status === 'diff'
						? 'DIFF'
						: result.status === 'trap'
							? 'TRAP'
							: result.status === 'linkerror'
								? 'LINKERR'
								: result.status === 'compile_error'
									? 'COMPILE'
									: 'ERROR';
			process.stderr.write(`${symbol}\n`);
			if (result.status !== 'pass') {
				if (result.error) console.error(`      error: ${result.error}`);
				if (result.driverStderr) {
					const trimmed = result.driverStderr.trim();
					if (trimmed) {
						console.error(`      driver stderr:`);
						for (const line of trimmed.split('\n')) console.error(`        ! ${line}`);
					}
				}
				if (result.diff && result.diff.length) {
					console.error(`      expected:`);
					for (const line of result.expected || []) console.error(`        > ${line}`);
					console.error(`      actual:`);
					for (const line of result.actual || []) console.error(`        < ${line}`);
				}
			}
		}
	}

	if (asJson) {
		process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
	}

	const failed = results.filter((r) => r.status !== 'pass');
	if (failed.length > 0) {
		if (!asJson) {
			console.error(`\n[canaries] ${failed.length} of ${results.length} FAILED`);
		}
		process.exit(1);
	}
	if (!asJson) {
		console.error(`\n[canaries] all ${results.length} passed`);
	}
}

main().catch((err) => {
	console.error(err.stack || err.message || err);
	process.exit(2);
});
