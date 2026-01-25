import * as fs from 'fs';
import * as path from 'path';
import {
  WasmState,
  WasmExports,
  ServerConfig,
  SessionStore,
  RouteHandler,
  DatabaseDriver,
} from '../types';
import { createWasmState } from './state';

/**
 * WASM import object type
 */
export type WasmImports = WebAssembly.Imports;

/**
 * Load WASM bytes from file
 */
export async function loadWasmBytes(wasmPath: string): Promise<Uint8Array> {
  const resolvedPath = path.resolve(wasmPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`WASM file not found: ${resolvedPath}`);
  }

  const bytes = await fs.promises.readFile(resolvedPath);
  return new Uint8Array(bytes);
}

/**
 * Compile WASM module from bytes
 */
export async function compileWasmModule(bytes: Uint8Array): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes.buffer as ArrayBuffer);
}

/**
 * Instantiate a WASM module with imports
 */
export async function instantiateWasm(
  module: WebAssembly.Module,
  imports: WasmImports
): Promise<WebAssembly.Instance> {
  return WebAssembly.instantiate(module, imports);
}

/**
 * Create a WASM instance with full state
 */
export async function createWasmInstance(
  module: WebAssembly.Module,
  imports: WasmImports,
  config: ServerConfig,
  sessionStore: SessionStore,
  routeRegistry: RouteHandler[],
  database?: DatabaseDriver
): Promise<WasmState> {
  const instance = await instantiateWasm(module, imports);
  return createWasmState(instance, config, sessionStore, routeRegistry, database);
}

/**
 * Call the start function on a WASM instance
 * Tries both 'start' and '_start' exports
 */
export function callStart(state: WasmState): void {
  const { exports } = state;

  if (typeof exports.start === 'function') {
    (exports.start as () => void)();
  } else if (typeof exports._start === 'function') {
    (exports._start as () => void)();
  }
  // If neither exists, silently do nothing (module might not need initialization)
}

/**
 * Call a handler function by index
 */
export function callHandler(state: WasmState, handlerIndex: number): number {
  const handlerName = `__handler_${handlerIndex}`;
  const handler = state.exports[handlerName];

  if (typeof handler !== 'function') {
    throw new Error(`Handler function not found: ${handlerName}`);
  }

  // Call handler and get pointer to response string
  return (handler as () => number)();
}

/**
 * Get exported function from WASM instance
 */
export function getExportedFunction(
  state: WasmState,
  name: string
): ((...args: number[]) => number) | undefined {
  const fn = state.exports[name];
  if (typeof fn === 'function') {
    return fn as (...args: number[]) => number;
  }
  return undefined;
}

/**
 * Check if WASM module has required exports
 */
export function validateWasmExports(exports: WasmExports): string[] {
  const errors: string[] = [];

  if (!exports.memory) {
    errors.push('Missing required export: memory');
  }

  if (!exports.malloc) {
    errors.push('Missing required export: malloc');
  }

  return errors;
}

/**
 * WASM loader that caches the compiled module
 */
export class WasmLoader {
  private module: WebAssembly.Module | null = null;
  private bytes: Uint8Array | null = null;
  private wasmPath: string;

  constructor(wasmPath: string) {
    this.wasmPath = wasmPath;
  }

  /**
   * Load and compile the WASM module (cached)
   */
  async load(): Promise<WebAssembly.Module> {
    if (this.module) {
      return this.module;
    }

    this.bytes = await loadWasmBytes(this.wasmPath);
    this.module = await compileWasmModule(this.bytes);

    return this.module;
  }

  /**
   * Create a new instance from the cached module
   */
  async createInstance(
    imports: WasmImports,
    config: ServerConfig,
    sessionStore: SessionStore,
    routeRegistry: RouteHandler[],
    database?: DatabaseDriver
  ): Promise<WasmState> {
    const module = await this.load();
    return createWasmInstance(module, imports, config, sessionStore, routeRegistry, database);
  }

  /**
   * Get the WASM file path
   */
  getPath(): string {
    return this.wasmPath;
  }
}
