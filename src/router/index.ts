import { RouteHandler } from '../types';

/**
 * Route registry for managing HTTP routes
 */
export class RouteRegistry {
  private routes: RouteHandler[] = [];
  private registrationCounter = 0;

  /**
   * Register a new route. `handlerName` is the WASM export to invoke at
   * dispatch time (e.g. `__route_handler_get__ping`). The framework picks the
   * naming convention; node-server only stores and dispatches by that name.
   */
  register(
    method: string,
    pattern: string,
    handlerName: string,
    isProtected: boolean = false,
    requiredRole?: string
  ): void {
    const { regex, paramNames } = this.compilePattern(pattern);

    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      regex,
      paramNames,
      handlerName,
      isProtected,
      requiredRole,
    });
  }

  /**
   * Find a matching route for a request
   */
  match(method: string, path: string): { route: RouteHandler; params: Record<string, string> } | null {
    const upperMethod = method.toUpperCase();

    const found = this.matchMethod(upperMethod, path);
    if (found) return found;

    // RFC 9110 §9.3.2: HEAD is identical to GET except the body MUST NOT be sent.
    // Express strips the body in res.send() when req.method === 'HEAD', so it is
    // safe to dispatch the GET handler. Explicit HEAD routes take precedence
    // because the first pass above already checked them.
    if (upperMethod === 'HEAD') {
      return this.matchMethod('GET', path);
    }

    return null;
  }

  private matchMethod(upperMethod: string, path: string): { route: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== upperMethod && route.method !== '*') {
        continue;
      }

      const match = route.regex.exec(path);
      if (match) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = decodeURIComponent(match[i + 1] || '');
        }
        return { route, params };
      }
    }
    return null;
  }

  /**
   * Register a static redirect route.
   * Called by the _http_redirect_route bridge function during WASM start().
   * Requests matching this route are redirected without invoking any WASM handler.
   */
  registerRedirect(method: string, pattern: string, to: string, status: number): void {
    const { regex, paramNames } = this.compilePattern(pattern);
    // Synthetic name — never dispatched (the redirectTo branch short-circuits
    // before any WASM call). Kept for type uniformity.
    const handlerName = `__redirect_${this.registrationCounter++}`;
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      regex,
      paramNames,
      handlerName,
      isProtected: false,
      redirectTo: to,
      redirectStatus: status,
    });
  }

  /**
   * Register an SSE (Server-Sent Events) stream route.
   * Called by the _http_sse_route bridge function during WASM start().
   * The handlerName is the exported WASM function name to call for this route.
   */
  registerSse(method: string, pattern: string, handlerName: string): void {
    const { regex, paramNames } = this.compilePattern(pattern);
    this.registrationCounter++;
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      regex,
      paramNames,
      handlerName,
      isProtected: false,
      isSse: true,
      sseHandlerName: handlerName,
    });
  }

  /**
   * Get all registered routes
   */
  getRoutes(): RouteHandler[] {
    return [...this.routes];
  }

  /**
   * Clear all routes
   */
  clear(): void {
    this.routes = [];
  }

  /**
   * Compile a route pattern to regex
   *
   * Supports:
   * - Static paths: /users
   * - Named parameters: /users/:id
   * - Wildcard: /files/*
   * - Optional parameters: /users/:id?
   */
  private compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    // Escape special regex characters except : and *
    let regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // Handle optional parameters like :id?
    regexPattern = regexPattern.replace(/:(\w+)\?/g, (_, name) => {
      paramNames.push(name);
      return '([^/]*)';
    });

    // Handle required parameters like :id
    regexPattern = regexPattern.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });

    // Handle wildcard *
    regexPattern = regexPattern.replace(/\*/g, '(.*)');

    // Anchor the pattern
    regexPattern = `^${regexPattern}$`;

    return {
      regex: new RegExp(regexPattern),
      paramNames,
    };
  }
}

/**
 * Parse query string to object
 */
export function parseQueryString(queryString: string): Record<string, string> {
  const params: Record<string, string> = {};

  if (!queryString) {
    return params;
  }

  // Remove leading ?
  const query = queryString.startsWith('?') ? queryString.slice(1) : queryString;

  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value || '');
    }
  }

  return params;
}

/**
 * Parse URL path and query
 */
export function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const [pathPart, queryPart] = url.split('?');
  return {
    path: pathPart || '/',
    query: parseQueryString(queryPart || ''),
  };
}
