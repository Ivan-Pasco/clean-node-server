import {
  WasmState,
  SyncHttpWorker,
  ServerConfig,
  SessionStore,
  RouteHandler,
  DatabaseDriver,
} from '../types';
import { WasmLoader, WasmImports } from './instance';
import { createBridgeImports } from '../bridge';

const DEFAULT_POOL_SIZE = Number(process.env.WASM_POOL_SIZE ?? '4');
const MAX_REQUEST_COUNT = 1000;
const MAX_HEAP_GROWTH_BYTES = 50 * 1024 * 1024;

interface PoolEntry {
  state: WasmState;
  requestCount: number;
  initialHeapPtr: number;
}

export class WasmInstancePool {
  private available: PoolEntry[] = [];
  private inUse = new Set<WasmState>();
  private entryMap = new Map<WasmState, PoolEntry>();
  private httpWorker?: SyncHttpWorker;

  constructor(
    private loader: WasmLoader,
    private config: ServerConfig,
    private sessionStore: SessionStore,
    private routeRegistry: RouteHandler[],
    private database?: DatabaseDriver,
    private poolSize = DEFAULT_POOL_SIZE
  ) {}

  async initialize(httpWorker?: SyncHttpWorker): Promise<void> {
    this.httpWorker = httpWorker;
    const spawns = Array.from({ length: this.poolSize }, () => this.spawn());
    const entries = await Promise.all(spawns);
    for (const entry of entries) {
      this.available.push(entry);
    }
  }

  private async spawn(): Promise<PoolEntry> {
    let state: WasmState | null = null;

    const imports: WasmImports = createBridgeImports(() => {
      if (!state) throw new Error('WasmInstancePool: state accessed before initialisation');
      return state;
    });

    state = await this.loader.createInstance(
      imports,
      this.config,
      this.sessionStore,
      this.routeRegistry,
      this.database,
      this.httpWorker
    );

    const entry: PoolEntry = {
      state,
      requestCount: 0,
      initialHeapPtr: this.readHeapPtr(state),
    };

    this.entryMap.set(state, entry);
    return entry;
  }

  async acquire(): Promise<WasmState> {
    const entry = this.available.pop() ?? await this.spawn();
    this.inUse.add(entry.state);
    entry.requestCount++;
    return entry.state;
  }

  release(state: WasmState): void {
    this.inUse.delete(state);
    const entry = this.entryMap.get(state);
    if (!entry) return;

    const heapGrown = this.readHeapPtr(state) - entry.initialHeapPtr;

    if (entry.requestCount >= MAX_REQUEST_COUNT || heapGrown > MAX_HEAP_GROWTH_BYTES) {
      this.entryMap.delete(state);
      this.spawn()
        .then((e) => { this.entryMap.set(e.state, e); this.available.push(e); })
        .catch((err) => console.error('[WasmInstancePool] spawn failed:', err));
    } else {
      this.reset(state);
      this.available.push(entry);
    }
  }

  private reset(state: WasmState): void {
    state.requestContext = undefined;
    state.response = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '',
      cookies: [],
    };
    state.httpClient = {
      timeout: 30000,
      userAgent: null,
      maxRedirects: 5,
      cookiesEnabled: false,
      cookieJar: new Map(),
      lastResponse: null,
    };
    state.injectedCss = undefined;
  }

  private readHeapPtr(state: WasmState): number {
    const global = (state.instance.exports as Record<string, unknown>).__heap_ptr;
    if (global && typeof (global as WebAssembly.Global).value === 'number') {
      return (global as WebAssembly.Global).value as number;
    }
    return state.memoryStats.initialHeapPtr;
  }

  close(): void {
    this.available = [];
    this.inUse.clear();
    this.entryMap.clear();
  }

  get availableCount(): number {
    return this.available.length;
  }

  get inUseCount(): number {
    return this.inUse.size;
  }
}
