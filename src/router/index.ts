import { RouteHandler } from '../types';

/**
 * Route registry for managing HTTP routes
 */
export class RouteRegistry {
  private routes: RouteHandler[] = [];

  /**
   * Register a new route
   */
  register(
    method: string,
    pattern: string,
    handlerIndex: number,
    isProtected: boolean = false,
    requiredRole?: string
  ): void {
    const { regex, paramNames } = this.compilePattern(pattern);

    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      regex,
      paramNames,
      handlerIndex,
      isProtected,
      requiredRole,
    });
  }

  /**
   * Find a matching route for a request
   */
  match(method: string, path: string): { route: RouteHandler; params: Record<string, string> } | null {
    const upperMethod = method.toUpperCase();

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
