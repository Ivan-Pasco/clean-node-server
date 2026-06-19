import { describe, it, expect, beforeEach } from 'vitest';
import { RouteRegistry, parseQueryString, parseUrl } from '../src/router';

// Test helper — the framework passes string handler-export names. Tests use
// synthetic names so failures show what was registered vs dispatched.
const handler = (n: number) => `__route_handler_${n}`;

describe('RouteRegistry', () => {
  let registry: RouteRegistry;

  beforeEach(() => {
    registry = new RouteRegistry();
  });

  describe('register and match', () => {
    it('should match a simple static route', () => {
      registry.register('GET', '/users', handler(0));

      const match = registry.match('GET', '/users');
      expect(match).not.toBeNull();
      expect(match?.route.handlerName).toBe(handler(0));
      expect(match?.params).toEqual({});
    });

    it('should not match different methods', () => {
      registry.register('GET', '/users', handler(0));

      const match = registry.match('POST', '/users');
      expect(match).toBeNull();
    });

    it('should match routes with parameters', () => {
      registry.register('GET', '/users/:id', handler(0));

      const match = registry.match('GET', '/users/123');
      expect(match).not.toBeNull();
      expect(match?.params).toEqual({ id: '123' });
    });

    it('should match routes with multiple parameters', () => {
      registry.register('GET', '/users/:userId/posts/:postId', handler(0));

      const match = registry.match('GET', '/users/42/posts/100');
      expect(match).not.toBeNull();
      expect(match?.params).toEqual({ userId: '42', postId: '100' });
    });

    it('should handle URL-encoded parameters', () => {
      registry.register('GET', '/search/:query', handler(0));

      const match = registry.match('GET', '/search/hello%20world');
      expect(match).not.toBeNull();
      expect(match?.params).toEqual({ query: 'hello world' });
    });

    it('should match wildcard routes', () => {
      registry.register('GET', '/files/*', handler(0));

      const match = registry.match('GET', '/files/path/to/file.txt');
      expect(match).not.toBeNull();
    });

    it('should not match when path has extra segments', () => {
      registry.register('GET', '/users', handler(0));

      const match = registry.match('GET', '/users/extra');
      expect(match).toBeNull();
    });

    it('should prefer exact matches over parameter matches', () => {
      registry.register('GET', '/users/me', handler(0));
      registry.register('GET', '/users/:id', handler(1));

      const match = registry.match('GET', '/users/me');
      expect(match).not.toBeNull();
      expect(match?.route.handlerName).toBe(handler(0));
    });

    it('should fall back to GET when matching HEAD (HTTP-HEAD-RETURNS-404)', () => {
      // RFC 9110: HEAD is identical to GET except the server MUST NOT send the
      // body. Without a fallback, HEAD requests against GET-registered routes
      // return 404 and our /metrics, /health, and every WASM-registered route
      // become invisible to load balancers and uptime checks that probe via HEAD.
      registry.register('GET', '/users', handler(0));

      const match = registry.match('HEAD', '/users');
      expect(match).not.toBeNull();
      expect(match?.route.handlerName).toBe(handler(0));
    });

    it('should prefer an explicit HEAD route over GET fallback', () => {
      // If both are registered, HEAD wins for HEAD requests so a handler can
      // emit HEAD-only headers (e.g. Last-Modified) without running the GET path.
      registry.register('GET', '/users', handler(0));
      registry.register('HEAD', '/users', handler(1));

      const match = registry.match('HEAD', '/users');
      expect(match?.route.handlerName).toBe(handler(1));
    });

    it('should still 404 HEAD when no GET or HEAD route is registered', () => {
      registry.register('POST', '/users', handler(0));

      const match = registry.match('HEAD', '/users');
      expect(match).toBeNull();
    });

    it('should preserve a non-sequential framework-chosen handler name (RTE002 guard)', () => {
      // The framework picks names like __route_handler_get__ping rather than
      // sequential indexes. node-server must store the name verbatim and
      // dispatch by it; reconstructing __route_handler_${i} was the RTE002
      // regression.
      registry.register('GET', '/ping', '__route_handler_get__ping');

      const match = registry.match('GET', '/ping');
      expect(match?.route.handlerName).toBe('__route_handler_get__ping');
    });
  });

  describe('protected routes', () => {
    it('should mark routes as protected', () => {
      registry.register('GET', '/admin', handler(0), true);

      const match = registry.match('GET', '/admin');
      expect(match?.route.isProtected).toBe(true);
    });

    it('should store required role', () => {
      registry.register('GET', '/admin', handler(0), true, 'admin');

      const match = registry.match('GET', '/admin');
      expect(match?.route.requiredRole).toBe('admin');
    });
  });

  describe('getRoutes', () => {
    it('should return all registered routes', () => {
      registry.register('GET', '/users', handler(0));
      registry.register('POST', '/users', handler(1));
      registry.register('GET', '/posts', handler(2));

      const routes = registry.getRoutes();
      expect(routes).toHaveLength(3);
    });

    it('should return a copy of routes', () => {
      registry.register('GET', '/users', handler(0));

      const routes1 = registry.getRoutes();
      const routes2 = registry.getRoutes();

      expect(routes1).not.toBe(routes2);
    });
  });

  describe('clear', () => {
    it('should remove all routes', () => {
      registry.register('GET', '/users', handler(0));
      registry.register('POST', '/users', handler(1));

      registry.clear();

      expect(registry.getRoutes()).toHaveLength(0);
      expect(registry.match('GET', '/users')).toBeNull();
    });
  });
});

describe('parseQueryString', () => {
  it('should parse simple query parameters', () => {
    const result = parseQueryString('foo=bar&baz=qux');
    expect(result).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('should handle URL-encoded values', () => {
    const result = parseQueryString('name=John%20Doe&city=New%20York');
    expect(result).toEqual({ name: 'John Doe', city: 'New York' });
  });

  it('should handle empty values', () => {
    const result = parseQueryString('flag=&other=value');
    expect(result).toEqual({ flag: '', other: 'value' });
  });

  it('should handle missing values', () => {
    const result = parseQueryString('flag&other=value');
    expect(result).toEqual({ flag: '', other: 'value' });
  });

  it('should return empty object for empty string', () => {
    const result = parseQueryString('');
    expect(result).toEqual({});
  });

  it('should strip leading question mark', () => {
    const result = parseQueryString('?foo=bar');
    expect(result).toEqual({ foo: 'bar' });
  });
});

describe('parseUrl', () => {
  it('should parse path and query', () => {
    const result = parseUrl('/users?sort=name&limit=10');
    expect(result.path).toBe('/users');
    expect(result.query).toEqual({ sort: 'name', limit: '10' });
  });

  it('should handle path without query', () => {
    const result = parseUrl('/users');
    expect(result.path).toBe('/users');
    expect(result.query).toEqual({});
  });

  it('should handle root path', () => {
    const result = parseUrl('/');
    expect(result.path).toBe('/');
    expect(result.query).toEqual({});
  });

  it('should handle empty input', () => {
    const result = parseUrl('');
    expect(result.path).toBe('/');
    expect(result.query).toEqual({});
  });
});
