import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
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
import {
  getRouteRegistry,
  setRouteRegistry,
  getConfiguredPort,
  getConfiguredHost,
  getCorsBridgeConfig,
  getRateLimitBridgeConfig,
  getGlobalErrorHandlerName,
} from './bridge/http-server';
import { startScheduler, stopScheduler } from './bridge/schedule';
import { startJobWorker, stopJobWorker } from './bridge/jobs';
import { attachWebsocketServer, stopWebsocketServer } from './bridge/websocket';
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
import {
  loadAlongside as loadBuildManifest,
  resolveArtifacts as resolveManifestArtifacts,
  ArtifactPurpose,
  ResolvedArtifact,
} from './build-manifest';

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
  // Init WASM instance retained for cron scheduler firing — schedule timers
  // call into its exports after the worker pool is spun up.
  private initState: WasmState | null = null;

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
    // Buffer binary bodies as a raw Buffer so _req_body_bytes can hand Clean
    // handlers the exact wire bytes. Without this, application/octet-stream
    // requests reach the WASM layer as an empty body, or (worse, with a
    // permissive text parser) as a UTF-8-decoded string that corrupts any
    // non-ASCII bytes. Limit matches the errors-dashboard tarball ceiling.
    this.app.use(express.raw({ type: 'application/octet-stream', limit: '200mb' }));

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

  /**
   * Install middleware driven by bridge calls made during WASM start().
   * Called after WASM start() runs but before the catch-all route is
   * registered, so the new middleware participates in request handling.
   *
   * Pre-implementation paired with FRAME-SERVER-CONFIG-FIELDS-UNIMPLEMENTED
   * (parent) and NODE-SERVER-CONFIG-BRIDGES-MISSING (this component).
   */
  private applyBridgeMiddleware(): void {
    const log = getLogger();

    const corsConfig = getCorsBridgeConfig();
    if (corsConfig && corsConfig.allowedOrigins.length > 0) {
      this.app.use(cors({
        origin: corsConfig.allowedOrigins.length === 1 && corsConfig.allowedOrigins[0] === '*'
          ? '*'
          : corsConfig.allowedOrigins,
        methods: corsConfig.allowedMethods.length > 0 ? corsConfig.allowedMethods : undefined,
        allowedHeaders: corsConfig.allowedHeaders.length > 0 ? corsConfig.allowedHeaders : undefined,
        maxAge: corsConfig.maxAge > 0 ? corsConfig.maxAge : undefined,
        credentials: corsConfig.allowCredentials,
      }));
      log.info({ corsConfig }, 'CORS configured via WASM bridge');
    }

    const rlConfig = getRateLimitBridgeConfig();
    if (rlConfig && rlConfig.perWindow > 0) {
      this.app.use(rateLimit({
        windowMs: rlConfig.windowSeconds * 1000,
        max: rlConfig.perWindow,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: rlConfig.keyStrategy === 'user'
          ? (req: Request): string => (req.cookies?.session_id as string | undefined) ?? req.ip ?? 'anon'
          : undefined,
      }));
      log.info({ rlConfig }, 'Rate limit configured via WASM bridge');
    }

    const handlerName = getGlobalErrorHandlerName();
    if (handlerName) {
      log.info({ handlerName }, 'Global error handler registered via WASM bridge');
    }
  }

  async initialize(): Promise<void> {
    const log = createLogger(this.config.verbose);

    this.wasmModule = await this.loader.load();
    setRouteRegistry(this.routeRegistry);

    const initState = await this.createInitInstance();
    this.initState = initState;
    const { exports } = initState;

    preGrowMemory(exports, this.config.preGrowMemoryBytes);

    if (typeof exports.start === 'function') {
      (exports.start as () => void)();
    } else if (typeof exports._start === 'function') {
      (exports._start as () => void)();
    }

    // Cron schedules registered during start() are inert until the scheduler
    // is wired to the WASM instance whose exports it should fire. The jobs
    // worker reads the same init instance for handler dispatch.
    startScheduler(initState);
    startJobWorker(initState);

    // Bridge-driven server config (FRAME-SERVER-CONFIG-FIELDS-UNIMPLEMENTED
    // pre-implementation): apply CORS / rate-limit middleware now that
    // WASM start() has had a chance to call _cors_configure /
    // _rate_limit_configure. These run before the catch-all route below.
    this.applyBridgeMiddleware();

    if (this.config.verbose) {
      log.info({ routes: this.routeRegistry.getRoutes().length }, 'Routes registered');
      for (const route of this.routeRegistry.getRoutes()) {
        log.debug({ method: route.method, pattern: route.pattern, handler: route.handlerName, protected: route.isProtected }, 'route');
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

    // Frame.ui client runtime: serve loader.js from the installed plugin,
    // falling back to an embedded no-op stub. Cached for 1 hour.
    const loaderJs = loadRuntimeLoaderJs();
    this.app.get('/loader.js', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      // Override the security middleware's no-cache headers
      res.removeHeader('Pragma');
      res.removeHeader('Expires');
      res.status(200).send(loaderJs);
    });

    // Plugin Contracts v2 — Build manifest (artifacts.md §5, §8).
    // Manifest-first artifact discovery: when build-manifest.json is present
    // next to the WASM, it is the authoritative source for artifact paths.
    // When absent (older compiler / Phase B compatibility), fall back to the
    // legacy CWD + public/ probe.
    const manifestResolved = this.loadAndResolveBuildManifest();
    const manifestFrontendPath = manifestResolved.find(
      (a) => a.purpose === ArtifactPurpose.CLIENT_HYDRATION,
    )?.absolutePath;
    const heuristicFrontendPath = manifestFrontendPath
      ? undefined
      : resolveFrontendWasmPath(this.loader.getPath());

    this.app.get('/frontend.wasm', (_req: Request, res: Response) => {
      // When the manifest declares the artifact, it is authoritative. A missing
      // file is a hard 404 — no falling back to ambient directories, per
      // contracts/artifacts.md §5.
      if (manifestFrontendPath) {
        try {
          const bytes = fs.readFileSync(manifestFrontendPath);
          res.setHeader('Content-Type', 'application/wasm');
          res.setHeader('Cache-Control', 'public, max-age=60');
          res.removeHeader('Pragma');
          res.removeHeader('Expires');
          res.status(200).send(bytes);
        } catch (err) {
          getLogger().error(
            { manifestFrontendPath, err: (err as Error).message },
            'Manifest-declared frontend.wasm missing',
          );
          res
            .status(404)
            .set('Content-Type', 'text/plain')
            .send(
              `frontend.wasm declared in build-manifest.json but not found at ${manifestFrontendPath}`,
            );
        }
        return;
      }
      // Phase B fallback: no manifest entry — probe legacy locations.
      const resolved = heuristicFrontendPath ?? findFrontendWasmFallback();
      if (!resolved) {
        res
          .status(404)
          .set('Content-Type', 'text/plain')
          .send('frontend.wasm not found — compile client components to generate it');
        return;
      }
      try {
        const bytes = fs.readFileSync(resolved);
        res.setHeader('Content-Type', 'application/wasm');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.removeHeader('Pragma');
        res.removeHeader('Expires');
        res.status(200).send(bytes);
      } catch (err) {
        res
          .status(404)
          .set('Content-Type', 'text/plain')
          .send(`frontend.wasm read failed: ${(err as Error).message}`);
      }
    });

    // Register routes for every other public artifact the manifest declared —
    // chiefly static assets like `theme.css` from frame.ui (artifacts.md §4.2).
    // `frontend.wasm` and `loader.js` already have dedicated handlers above; the
    // manifest entry for `frontend.wasm` is consumed by the dedicated route, not
    // duplicated as a fallback.
    this.registerManifestArtifactRoutes(manifestResolved);

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

    const { body, bodyBytes } = this.getRequestBody(req);
    const context: RequestContext = {
      method: req.method,
      path,
      params,
      query,
      headers: this.normalizeHeaders(req.headers),
      body,
      bodyBytes,
      cookies: req.cookies || {},
      sessionId: req.cookies?.session_id,
    };

    // Static redirect routes are resolved immediately — no WASM handler needed.
    if (route.redirectTo) {
      const status = route.redirectStatus ?? 302;
      res.setHeader('Location', route.redirectTo);
      res.status(status).end();
      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      httpRequestsTotal.inc({ method: req.method, route: routeLabel, status_code: status });
      httpRequestDuration.observe({ method: req.method, route: routeLabel }, durationSec);
      return;
    }

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
      const result = await this.requestPool.dispatch(context, route.handlerName);

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

      // Bridge-driven global error handler (FRAME-SERVER-CONFIG-FIELDS-UNIMPLEMENTED
      // pre-implementation). Timeouts/overload are infrastructure failures and
      // skip the handler — the WASM handler can't help if the pool is gone.
      const handlerName = getGlobalErrorHandlerName();
      if (handlerName && !isTimeout && !isOverload && this.requestPool) {
        try {
          const fallbackResult = await this.requestPool.dispatch(context, handlerName);
          for (const cookie of fallbackResult.cookies) {
            res.cookie(cookie.name, cookie.value, (cookie.options ?? {}) as Record<string, unknown>);
          }
          for (const [name, value] of Object.entries(fallbackResult.headers)) {
            if (name.toLowerCase() === 'content-type') res.type(value);
            else res.setHeader(name, value);
          }
          res.status(fallbackResult.status).send(fallbackResult.body);
          httpRequestsTotal.inc({ method: req.method, route: routeLabel, status_code: fallbackResult.status });
          return;
        } catch {
          // Fall through to the default error envelope below.
        }
      }

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
    stopScheduler();
    stopJobWorker();
    stopWebsocketServer();
    const deadline = Date.now() + timeoutMs;
    while (this.inflightCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.inflightCount > 0) {
      log.warn({ inflightCount: this.inflightCount }, 'Forcing shutdown with requests still in-flight');
    }
    await this.requestPool?.close();
    this.httpWorker?.close();
    this.initState = null;
  }

  private normalizeHeaders(headers: Request['headers']): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v;
      else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
    }
    return out;
  }

  private getRequestBody(req: Request): { body: string; bodyBytes?: Uint8Array } {
    // Binary bodies (via express.raw) arrive as a Node Buffer. Preserve the
    // raw octets on bodyBytes so `_req_body_bytes` can hand them to Clean
    // handlers untouched — the string form is a best-effort latin1 view kept
    // only so `_req_body` returns something non-empty for legacy callers.
    if (Buffer.isBuffer(req.body)) {
      const buf = req.body;
      const bodyBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      return { body: buf.toString('latin1'), bodyBytes };
    }
    if (typeof req.body === 'string') return { body: req.body };
    if (req.body && typeof req.body === 'object') return { body: JSON.stringify(req.body) };
    return { body: '' };
  }

  start(port?: number): Promise<void> {
    const listenPort = port || getConfiguredPort() || this.config.port;
    // Bridge-driven host (via _http_listen_on) takes precedence over the
    // construct-time config — same precedence model as port.
    const host = getConfiguredHost() ?? this.config.host;

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
        if (this.initState && this.httpServer) {
          attachWebsocketServer(this.httpServer as http.Server, this.initState)
            .catch((err) => log.warn({ err }, 'WebSocket upgrade handler failed to attach'));
        }
        resolve();
      });
      this.httpServer.on('error', reject);
    });
  }

  /**
   * Load `build-manifest.json` next to the main WASM and resolve every entry's
   * absolute path. Returns `[]` when the manifest is absent, unparseable, or
   * empty — the caller falls back to legacy heuristics in that case.
   *
   * Plugin Contracts v2 — artifacts.md §5/§8.
   */
  private loadAndResolveBuildManifest(): ResolvedArtifact[] {
    const log = getLogger();
    const wasmPath = this.loader.getPath();
    const result = loadBuildManifest(wasmPath);
    if (result.parseError) {
      log.warn(
        { manifestPath: result.parseError.manifestPath, reason: result.parseError.reason },
        'Build manifest present but unreadable; falling back to legacy artifact lookup',
      );
      return [];
    }
    if (!result.manifest) {
      log.debug({ wasmPath }, 'No build-manifest.json next to WASM; using legacy artifact discovery');
      return [];
    }
    const mainWasmDir = path.dirname(wasmPath) || '.';
    const resolved = resolveManifestArtifacts(result.manifest, mainWasmDir);
    log.info(
      {
        compilerVersion: result.manifest.compiler_version,
        artifactCount: resolved.length,
        callbackCount: result.manifest.callbacks.length,
      },
      'Loaded build manifest',
    );
    // Warn (but do not refuse to start) on declared artifacts whose file is
    // missing on disk. Matches contracts/artifacts.md §8 and the Rust host's
    // "log a startup warning" path.
    for (const artifact of resolved) {
      if (!fs.existsSync(artifact.absolutePath)) {
        log.warn(
          { name: artifact.name, path: artifact.absolutePath, purpose: artifact.purpose },
          'Manifest-declared artifact file missing on disk',
        );
      }
    }
    return resolved;
  }

  /**
   * Register HTTP routes for every public artifact the manifest declared,
   * skipping the ones with dedicated handlers (`frontend.wasm`, `loader.js`).
   * Unknown purposes are skipped with a warning.
   *
   * Plugin Contracts v2 — artifacts.md §8.2.
   */
  private registerManifestArtifactRoutes(resolved: ResolvedArtifact[]): void {
    const RESERVED = new Set(['frontend.wasm', 'loader.js']);
    const log = getLogger();
    for (const artifact of resolved) {
      if (!artifact.public) continue;
      if (RESERVED.has(artifact.name)) continue;
      switch (artifact.purpose) {
        case ArtifactPurpose.CLIENT_HYDRATION:
        case ArtifactPurpose.STATIC_ASSET:
          break;
        case ArtifactPurpose.MANIFEST:
        case ArtifactPurpose.DATA_MIGRATION:
          // These purposes are runtime-internal; not served as HTTP routes.
          continue;
        default:
          log.warn(
            { name: artifact.name, purpose: artifact.purpose },
            'Skipping artifact route: unknown purpose',
          );
          continue;
      }
      const routePath = `/${artifact.name}`;
      const absolutePath = artifact.absolutePath;
      const contentType = artifact.contentType;
      log.info({ routePath, absolutePath, contentType }, 'Manifest artifact route registered');
      this.app.get(routePath, (_req: Request, res: Response) => {
        try {
          const bytes = fs.readFileSync(absolutePath);
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=60');
          res.removeHeader('Pragma');
          res.removeHeader('Expires');
          res.status(200).send(bytes);
        } catch (err) {
          res
            .status(404)
            .set('Content-Type', 'text/plain')
            .send(
              `${artifact.name} declared in build-manifest.json but read failed: ${(err as Error).message}`,
            );
        }
      });
    }
  }

  getApp(): express.Application {
    return this.app;
  }
}

/**
 * Embedded loader.js stub served when the frame.ui plugin runtime is not installed.
 *
 * Boots hydration for [data-island][data-client] elements by fetching
 * /islands-manifest.json and (TODO: also instantiating /frontend.wasm exports).
 * The full implementation lives in the frame.ui plugin runtime; this stub keeps
 * the route serving valid JS so dev environments don't 404.
 */
const LOADER_JS_STUB = `(function(){'use strict';
var islands=document.querySelectorAll('[data-island][data-client]');
if(islands.length===0)return;
console.warn('[frame.ui] loader stub active — install frame.ui runtime for full hydration');
})();`;

function loadRuntimeLoaderJs(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) return LOADER_JS_STUB;
  const candidatePath = path.join(home, '.cleen', 'plugins', 'frame.ui', 'runtime', 'loader.js');
  try {
    return fs.readFileSync(candidatePath, 'utf8');
  } catch {
    return LOADER_JS_STUB;
  }
}

function resolveFrontendWasmPath(mainWasmPath: string): string | undefined {
  const sibling = path.join(path.dirname(mainWasmPath), 'frontend.wasm');
  if (fs.existsSync(sibling)) return sibling;
  return undefined;
}

function findFrontendWasmFallback(): string | undefined {
  const candidates = [
    path.join(process.cwd(), 'frontend.wasm'),
    path.join(process.cwd(), 'public', 'frontend.wasm'),
    path.join(process.cwd(), 'dist', 'frontend.wasm'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
