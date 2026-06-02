import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import pinoHttp from 'pino-http';
import {
  WasmState,
  ServerConfig,
  RequestContext,
  RouteHandler,
  AnySessionStore,
  DatabaseDriver,
  SyncHttpWorker,
} from './types';
import { WasmLoader } from './wasm/instance';
import { setRequestContext, getResponse } from './wasm/state';
import { RouteRegistry, parseUrl } from './router';
import { createBridgeImports } from './bridge';
import { getRouteRegistry, setRouteRegistry, getConfiguredPort } from './bridge/http-server';
import { readLengthPrefixedString, preGrowMemory } from './wasm/memory';
import { getSandboxRoot } from './bridge/file';
import type { SseWorkerInit, SseWorkerOutbound } from './workers/worker-types';
import { SyncHttpClient } from './bridge/http-client';
import { RequestWorkerPool } from './workers/request-pool';
import { createLogger, getLogger } from './telemetry/logger';
import {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
  workerPoolAvailable,
  workerPoolInUse,
  workerPoolQueued,
  workerPoolTotal,
} from './telemetry/metrics';

const DEFAULT_POOL_SIZE = Number(process.env.WASM_POOL_SIZE ?? '4');

export class CleanNodeServer {
  private app: express.Application;
  private loader: WasmLoader;
  private config: ServerConfig;
  private sessionStore: AnySessionStore;
  private database?: DatabaseDriver;
  private routeRegistry: RouteRegistry;
  private wasmModule: WebAssembly.Module | null = null;
  private httpServer: http.Server | https.Server | null = null;
  private requestPool: RequestWorkerPool | null = null;
  private httpWorker: SyncHttpWorker | null = null;
  private inflightCount = 0;

  constructor(
    wasmPath: string,
    config: ServerConfig,
    sessionStore: AnySessionStore,
    database?: DatabaseDriver
  ) {
    this.app = express();
    this.loader = new WasmLoader(wasmPath);
    this.config = config;
    this.sessionStore = sessionStore;
    this.database = database;
    this.routeRegistry = new RouteRegistry();
    this.httpWorker = new SyncHttpClient();

    this.setupMiddleware();
  }

  private setupMiddleware(): void {
    const log = createLogger(this.config.verbose);

    if (this.config.rateLimitMax && this.config.rateLimitMax > 0) {
      this.app.use(rateLimit({
        windowMs: this.config.rateLimitWindowMs ?? 60_000,
        max: this.config.rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
      }));
    }

    if (this.config.corsOrigin) {
      this.app.use(cors({ origin: this.config.corsOrigin, credentials: true }));
    }

    // Structured request logging with auto-generated correlation IDs.
    this.app.use(pinoHttp({
      logger: log,
      genReqId: (req) =>
        (req.headers['x-request-id'] as string | undefined) || randomUUID(),
      customSuccessMessage: (req, res) =>
        `${req.method} ${req.url} ${res.statusCode}`,
      customErrorMessage: (req, res, err) =>
        `${req.method} ${req.url} ${res.statusCode} — ${err.message}`,
      autoLogging: this.config.verbose,
    }));

    // Propagate request ID to response header for client-side correlation.
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Request-ID', (req as unknown as { id: string }).id ?? randomUUID());
      next();
    });

    // Compress all responses (gzip/deflate/br).
    this.app.use(compression());

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    this.app.use(cookieParser());
    this.app.use(express.text({ type: 'text/*', limit: '10mb' }));

    // Security headers.
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'");
      if (this.config.tlsCert) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });
  }

  async initialize(): Promise<void> {
    const log = createLogger(this.config.verbose);

    this.wasmModule = await this.loader.load();
    setRouteRegistry(this.routeRegistry);

    const initState = await this.createInitInstance();
    const { exports } = initState;

    preGrowMemory(exports, this.config.preGrowMemoryBytes);

    if (typeof exports.start === 'function') {
      (exports.start as () => void)();
    } else if (typeof exports._start === 'function') {
      (exports._start as () => void)();
    }

    if (this.config.verbose) {
      log.info({ routes: this.routeRegistry.getRoutes().length }, 'Routes registered');
      for (const route of this.routeRegistry.getRoutes()) {
        log.debug({ method: route.method, pattern: route.pattern, handler: route.handlerIndex, protected: route.isProtected }, 'route');
      }
    }

    // Health check — before catch-all.
    this.app.get('/health', (_req: Request, res: Response) => {
      const pool = this.requestPool;
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        workers: pool ? {
          available: pool.availableCount,
          inUse: pool.inUseCount,
          queued: pool.queuedCount,
          total: pool.totalWorkers,
        } : undefined,
      });
    });

    // Prometheus metrics endpoint.
    this.app.get('/metrics', async (_req: Request, res: Response) => {
      if (this.requestPool) {
        workerPoolAvailable.set(this.requestPool.availableCount);
        workerPoolInUse.set(this.requestPool.inUseCount);
        workerPoolQueued.set(this.requestPool.queuedCount);
        workerPoolTotal.set(this.requestPool.totalWorkers);
      }
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    });

    this.app.all('*', this.handleRequest.bind(this));

    const pgPoolSize = this.config.pgPoolSize ?? 20;
    const perWorkerPg = Math.max(2, Math.floor(pgPoolSize / DEFAULT_POOL_SIZE));

    this.requestPool = new RequestWorkerPool(
      {
        wasmPath: this.loader.getPath(),
        config: this.config,
        databaseUrl: this.config.databaseUrl,
        sandboxRoot: getSandboxRoot(),
        pgMaxConnections: perWorkerPg,
      },
      DEFAULT_POOL_SIZE,
      this.sessionStore
    );
    await this.requestPool.initialize();

    log.info({ workers: DEFAULT_POOL_SIZE, pgPerWorker: perWorkerPg }, 'Worker pool ready');
  }

  private async createInitInstance(): Promise<WasmState> {
    if (!this.wasmModule) throw new Error('WASM module not loaded');

    let state: WasmState | null = null;
    const imports = createBridgeImports(() => {
      if (!state) throw new Error('WASM state not initialized');
      return state;
    });

    state = await this.loader.createInstance(
      imports,
      this.config,
      // Init instance only calls start() for route discovery — never processes session ops.
      this.sessionStore as import('./types').SessionStore,
      this.routeRegistry.getRoutes(),
      this.database,
      this.httpWorker ?? undefined
    );
    return state;
  }

  private async handleRequest(req: Request, res: Response): Promise<void> {
    const startNs = process.hrtime.bigint();
    const { path, query } = parseUrl(req.url);
    const match = this.routeRegistry.match(req.method, path);

    if (!match) {
      res.status(404).json({
        ok: false,
        err: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${path}` },
      });
      return;
    }

    const { route, params } = match;
    const routeLabel = route.pattern;

    // Auth check on the main thread (session store lives here).
    if (route.isProtected) {
      const sessionId = req.cookies?.session_id;
      const session = sessionId ? await this.sessionStore.get(sessionId) : undefined;

      if (!session) {
        res.status(401).json({ ok: false, err: { code: 'AUTH_ERROR', message: 'Authentication required' } });
        return;
      }
      if (route.requiredRole && session.role !== route.requiredRole) {
        res.status(403).json({ ok: false, err: { code: 'PERMISSION_DENIED', message: `Role '${route.requiredRole}' required` } });
        return;
      }
    }

    const context: RequestContext = {
      method: req.method,
      path,
      params,
      query,
      headers: this.normalizeHeaders(req.headers),
      body: this.getRequestBody(req),
      cookies: req.cookies || {},
      sessionId: req.cookies?.session_id,
    };

    // SSE routes bypass the worker pool and run in a dedicated per-connection worker.
    if (route.isSse) {
      return this.handleSseRequest(req, res, route, context);
    }

    if (!this.requestPool) {
      res.status(503).json({ ok: false, err: { code: 'NOT_READY', message: 'Worker pool not initialized' } });
      return;
    }

    this.inflightCount++;
    try {
      const result = await this.requestPool.dispatch(context, route.handlerIndex);

      for (const cookie of result.cookies) {
        res.cookie(cookie.name, cookie.value, (cookie.options ?? {}) as Record<string, unknown>);
      }
      for (const [name, value] of Object.entries(result.headers)) {
        if (name.toLowerCase() === 'content-type') res.type(value);
        else res.setHeader(name, value);
      }

      res.status(result.status).send(result.body);

      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      httpRequestsTotal.inc({ method: req.method, route: routeLabel, status_code: result.status });
      httpRequestDuration.observe({ method: req.method, route: routeLabel }, durationSec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      const isTimeout = msg.includes('timed out');
      const isOverload = msg.includes('queue full');
      const status = isTimeout || isOverload ? 503 : 500;

      res.status(status).json({
        ok: false,
        err: { code: isTimeout ? 'TIMEOUT' : isOverload ? 'OVERLOADED' : 'INTERNAL_ERROR', message: msg },
      });

      httpRequestsTotal.inc({ method: req.method, route: routeLabel, status_code: status });
    } finally {
      this.inflightCount--;
    }
  }

  /**
   * Handle an SSE (STREAM) route request.
   *
   * Spawns a dedicated SSE worker thread that owns a fresh WASM instance.
   * The WASM handler runs synchronously in the worker; each _sse_emit call
   * posts a message to the main thread, which writes it to the Express response.
   * Client disconnect is signaled via a SharedArrayBuffer so the WASM handler
   * can break out of its streaming loop via _sse_is_connected().
   */
  private handleSseRequest(
    req: Request,
    res: Response,
    route: RouteHandler,
    context: RequestContext
  ): void {
    const log = createLogger(this.config.verbose);

    if (!route.sseHandlerName) {
      res.status(500).json({ ok: false, err: { code: 'INTERNAL_ERROR', message: 'SSE route has no handler name' } });
      return;
    }

    // SSE wire-protocol headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Override the default no-cache headers set by the security middleware
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    res.flushHeaders();

    // 4-byte SAB: Int32Array[0] = 1 (connected) | 0 (disconnected)
    const sseControlBuffer = new SharedArrayBuffer(4);
    const sseControl = new Int32Array(sseControlBuffer);
    Atomics.store(sseControl, 0, 1);

    const workerInit: SseWorkerInit = {
      wasmPath: this.loader.getPath(),
      config: this.config,
      databaseUrl: this.config.databaseUrl,
      sandboxRoot: getSandboxRoot(),
      sseControlBuffer,
    };

    const worker = new Worker(
      path.join(__dirname, 'workers', 'sse-worker.js'),
      { workerData: workerInit }
    );

    let streamEnded = false;
    const endStream = (): void => {
      if (streamEnded) return;
      streamEnded = true;
      try { res.end(); } catch { /* already closed */ }
      void worker.terminate().catch(() => undefined);
    };

    worker.on('message', (msg: SseWorkerOutbound) => {
      switch (msg.type) {
        case 'ready':
          worker.postMessage({
            type: 'sse_request',
            context,
            handlerName: route.sseHandlerName!,
          });
          break;
        case 'sse_emit':
          if (!streamEnded) res.write(`data: ${msg.data}\n\n`);
          break;
        case 'sse_emit_event':
          if (!streamEnded) res.write(`event: ${msg.name}\ndata: ${msg.data}\n\n`);
          break;
        case 'sse_retry':
          if (!streamEnded) res.write(`retry: ${msg.ms}\n\n`);
          break;
        case 'sse_close':
        case 'sse_done':
          endStream();
          break;
        case 'fatal':
          log.error({ handler: route.sseHandlerName, msg }, 'SSE worker error');
          endStream();
          break;
      }
    });

    worker.on('error', (err) => {
      log.error({ err }, 'SSE worker uncaught error');
      endStream();
    });

    // Client disconnected — signal the WASM handler via the SAB
    req.on('close', () => {
      Atomics.store(sseControl, 0, 0);
      // Give the WASM handler ~5 s to observe the disconnect and return cleanly
      setTimeout(endStream, 5000);
    });
  }

  async gracefulShutdown(timeoutMs = 30000): Promise<void> {
    const log = getLogger();
    this.httpServer?.close();
    const deadline = Date.now() + timeoutMs;
    while (this.inflightCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.inflightCount > 0) {
      log.warn({ inflightCount: this.inflightCount }, 'Forcing shutdown with requests still in-flight');
    }
    await this.requestPool?.close();
    this.httpWorker?.close();
  }

  private normalizeHeaders(headers: Request['headers']): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v;
      else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
    }
    return out;
  }

  private getRequestBody(req: Request): string {
    if (typeof req.body === 'string') return req.body;
    if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
    return '';
  }

  start(port?: number): Promise<void> {
    const listenPort = port || getConfiguredPort() || this.config.port;
    const host = this.config.host;

    return new Promise((resolve, reject) => {
      if (this.config.tlsCert && this.config.tlsKey) {
        let cert: Buffer, key: Buffer;
        try {
          cert = fs.readFileSync(this.config.tlsCert);
          key = fs.readFileSync(this.config.tlsKey);
        } catch (err) {
          reject(new Error(`Failed to read TLS files: ${(err as Error).message}`));
          return;
        }
        this.httpServer = https.createServer({ cert, key }, this.app);
      } else {
        this.httpServer = http.createServer(this.app);
      }

      // Keep-alive tuning: prevents "socket hang up" errors from load balancers
      // that hold connections open longer than Node's default 5s timeout.
      this.httpServer.keepAliveTimeout = 65_000;
      (this.httpServer as http.Server).headersTimeout = 66_000;

      const protocol = this.config.tlsCert ? 'https' : 'http';
      this.httpServer.listen(listenPort, host, () => {
        const log = getLogger();
        log.info({ protocol, host, port: listenPort }, 'Clean Node Server listening');
        resolve();
      });
      this.httpServer.on('error', reject);
    });
  }

  getApp(): express.Application {
    return this.app;
  }
}

