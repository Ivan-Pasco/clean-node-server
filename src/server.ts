import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import {
  WasmState,
  ServerConfig,
  RequestContext,
  SessionStore,
  DatabaseDriver,
} from './types';
import { WasmLoader, WasmImports } from './wasm/instance';
import { setRequestContext, getResponse } from './wasm/state';
import { RouteRegistry, parseUrl } from './router';
import { createBridgeImports } from './bridge';
import { getRouteRegistry, setRouteRegistry, getConfiguredPort } from './bridge/http-server';
import { readLengthPrefixedString } from './wasm/memory';

/**
 * Clean Node Server
 *
 * HTTP server that runs Clean Language WASM modules
 */
export class CleanNodeServer {
  private app: express.Application;
  private loader: WasmLoader;
  private config: ServerConfig;
  private sessionStore: SessionStore;
  private database?: DatabaseDriver;
  private routeRegistry: RouteRegistry;
  private wasmModule: WebAssembly.Module | null = null;

  constructor(
    wasmPath: string,
    config: ServerConfig,
    sessionStore: SessionStore,
    database?: DatabaseDriver
  ) {
    this.app = express();
    this.loader = new WasmLoader(wasmPath);
    this.config = config;
    this.sessionStore = sessionStore;
    this.database = database;
    this.routeRegistry = new RouteRegistry();

    this.setupMiddleware();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Parse JSON bodies
    this.app.use(express.json({ limit: '10mb' }));

    // Parse URL-encoded bodies
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Parse cookies
    this.app.use(cookieParser());

    // Raw body for non-JSON requests
    this.app.use(express.text({ type: 'text/*', limit: '10mb' }));

    // Request logging in verbose mode
    if (this.config.verbose) {
      this.app.use((req: Request, _res: Response, next: NextFunction) => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
        next();
      });
    }

    // Disable caching and ensure proper MIME type handling
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });
  }

  /**
   * Initialize the server by loading WASM and calling start()
   */
  async initialize(): Promise<void> {
    // Load and compile WASM module
    this.wasmModule = await this.loader.load();

    // Set shared route registry
    setRouteRegistry(this.routeRegistry);

    // Create initial instance to call start() and register routes
    const initState = await this.createWasmState();

    // Call start function to register routes
    const { exports } = initState;
    if (typeof exports.start === 'function') {
      (exports.start as () => void)();
    } else if (typeof exports._start === 'function') {
      (exports._start as () => void)();
    }

    // Setup catch-all route handler
    this.app.all('*', this.handleRequest.bind(this));

    if (this.config.verbose) {
      console.log(`Registered ${this.routeRegistry.getRoutes().length} routes`);
      for (const route of this.routeRegistry.getRoutes()) {
        console.log(`  ${route.method} ${route.pattern} -> handler_${route.handlerIndex}${route.isProtected ? ' (protected)' : ''}`);
      }
    }
  }

  /**
   * Create a new WASM state instance for request handling
   */
  private async createWasmState(): Promise<WasmState> {
    if (!this.wasmModule) {
      throw new Error('WASM module not loaded');
    }

    // State will be set after instantiation
    let state: WasmState | null = null;

    // Create bridge imports with state getter
    const imports = createBridgeImports(() => {
      if (!state) {
        throw new Error('WASM state not initialized');
      }
      return state;
    });

    // Create instance
    state = await this.loader.createInstance(
      imports,
      this.config,
      this.sessionStore,
      this.routeRegistry.getRoutes(),
      this.database
    );

    return state;
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: Request, res: Response): Promise<void> {
    const { path, query } = parseUrl(req.url);

    // Match route
    const match = this.routeRegistry.match(req.method, path);

    if (!match) {
      res.status(404).json({
        ok: false,
        err: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${path}` },
      });
      return;
    }

    const { route, params } = match;

    // Create fresh WASM instance for this request
    let state: WasmState;
    try {
      state = await this.createWasmState();
    } catch (err) {
      console.error('Failed to create WASM instance:', err);
      res.status(500).json({
        ok: false,
        err: { code: 'INTERNAL_ERROR', message: 'Failed to initialize request handler' },
      });
      return;
    }

    // Build request context
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

    // Set context on state
    setRequestContext(state, context);

    // Check authentication for protected routes
    if (route.isProtected) {
      const session = context.sessionId
        ? this.sessionStore.get(context.sessionId)
        : undefined;

      if (!session) {
        res.status(401).json({
          ok: false,
          err: { code: 'AUTH_ERROR', message: 'Authentication required' },
        });
        return;
      }

      if (route.requiredRole && session.role !== route.requiredRole) {
        res.status(403).json({
          ok: false,
          err: { code: 'PERMISSION_DENIED', message: `Role '${route.requiredRole}' required` },
        });
        return;
      }
    }

    // Call handler
    try {
      const handlerName = `__route_handler_${route.handlerIndex}`;
      const handler = state.exports[handlerName];

      if (typeof handler !== 'function') {
        throw new Error(`Handler function not found: ${handlerName}`);
      }

      // Call the handler - it may return a pointer to response string
      const resultPtr = (handler as () => number)();

      // If handler returns a pointer, read the response body from it
      if (resultPtr > 0) {
        const responseBody = readLengthPrefixedString(state.exports.memory, resultPtr);
        if (responseBody) {
          state.response.body = responseBody;
        }
      }

      // Auto-detect Content-Type if still default and body looks like HTML
      const body = state.response.body;
      if (
        state.response.headers['Content-Type'] === 'application/json' &&
        body &&
        (body.trimStart().startsWith('<!DOCTYPE') ||
         body.trimStart().startsWith('<html') ||
         body.trimStart().startsWith('<HTML'))
      ) {
        state.response.headers['Content-Type'] = 'text/html; charset=utf-8';
      }

      // Get response from state
      const response = getResponse(state);

      // Set cookies
      if (response.cookies) {
        for (const cookie of response.cookies) {
          res.cookie(cookie.name, cookie.value, cookie.options || {});
        }
      }

      // Set headers
      for (const [name, value] of Object.entries(response.headers)) {
        if (name.toLowerCase() === 'content-type') {
          res.type(value);
        } else {
          res.setHeader(name, value);
        }
      }

      // Send response
      res.status(response.status).send(response.body);
    } catch (err) {
      console.error('Handler error:', err);
      res.status(500).json({
        ok: false,
        err: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
        },
      });
    }
  }

  /**
   * Normalize request headers to lowercase keys
   */
  private normalizeHeaders(headers: Request['headers']): Record<string, string> {
    const normalized: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        normalized[key.toLowerCase()] = value;
      } else if (Array.isArray(value)) {
        normalized[key.toLowerCase()] = value.join(', ');
      }
    }

    return normalized;
  }

  /**
   * Get request body as string
   */
  private getRequestBody(req: Request): string {
    if (typeof req.body === 'string') {
      return req.body;
    }

    if (req.body && typeof req.body === 'object') {
      return JSON.stringify(req.body);
    }

    return '';
  }

  /**
   * Start the HTTP server
   */
  start(port?: number): Promise<void> {
    const listenPort = port || getConfiguredPort() || this.config.port;
    const host = this.config.host;

    return new Promise((resolve) => {
      this.app.listen(listenPort, host, () => {
        console.log(`Clean Node Server listening on http://${host}:${listenPort}`);
        resolve();
      });
    });
  }

  /**
   * Get the Express app (for testing)
   */
  getApp(): express.Application {
    return this.app;
  }
}
