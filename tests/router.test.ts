import { describe, it, expect, beforeEach } from 'vitest';
import { RouteRegistry, parseQueryString, parseUrl } from '../src/router';

describe('RouteRegistry', () => {
  let registry: RouteRegistry;

  beforeEach(() => {
    registry = new RouteRegistry();
  });

  describe('register and match', () => {
    it('should match a simple static route', () => {
      registry.register('GET', '/users', 0);

      const match = registry.match('GET', '/users');
      expect(match).not.toBeNull();
      expect(match?.route.handlerIndex).toBe(0);
      expect(match?.params).toEqual({});
    });

    it('should not match different methods', () => {
      registry.register('GET', '/users', 0);

      const match = registry.match('POST', '/users');
      expect(match).toBeNull();
    });

    it('should match routes with parameters', () => {
      registry.register('GET', '/users/:id', 0);

      const match = registry.match('GET', '/users/123');
      expect(match).not.toBeNull();
      expect(match?.params).toEqual({ id: '123' });
    });

    it('should match routes with multiple parameters', () => {
      registry.register('GET', '/users/:userId/posts/:postId', 0);

      const match = registry.match('GET', '/users/42/posts/100');
      expect(match).not.toBeNull();
      expect(match?.params).toEqual({ userId: '42', postId: '100' });
    });

    it('should handle URL-encoded parameters', () => {
      registry.register('GET', '/search/:query', 0);

      const match = registry.match('GET', '/search/hello%20world');
      expect(match).not.toBeNull();
      expect(match?.params).toEqual({ query: 'hello world' });
    });

    it('should match wildcard routes', () => {
      registry.register('GET', '/files/*', 0);

      const match = registry.match('GET', '/files/path/to/file.txt');
      expect(match).not.toBeNull();
    });

    it('should not match when path has extra segments', () => {
      registry.register('GET', '/users', 0);

      const match = registry.match('GET', '/users/extra');
      expect(match).toBeNull();
    });

    it('should prefer exact matches over parameter matches', () => {
      registry.register('GET', '/users/me', 0);
      registry.register('GET', '/users/:id', 1);

      const match = registry.match('GET', '/users/me');
      expect(match).not.toBeNull();
      expect(match?.route.handlerIndex).toBe(0);
    });
  });

  describe('protected routes', () => {
    it('should mark routes as protected', () => {
      registry.register('GET', '/admin', 0, true);

      const match = registry.match('GET', '/admin');
      expect(match?.route.isProtected).toBe(true);
    });

    it('should store required role', () => {
      registry.register('GET', '/admin', 0, true, 'admin');

      const match = registry.match('GET', '/admin');
      expect(match?.route.requiredRole).toBe('admin');
    });
  });

  describe('getRoutes', () => {
    it('should return all registered routes', () => {
      registry.register('GET', '/users', 0);
      registry.register('POST', '/users', 1);
      registry.register('GET', '/posts', 2);

      const routes = registry.getRoutes();
      expect(routes).toHaveLength(3);
    });

    it('should return a copy of routes', () => {
      registry.register('GET', '/users', 0);

      const routes1 = registry.getRoutes();
      const routes2 = registry.getRoutes();

      expect(routes1).not.toBe(routes2);
    });
  });

  describe('clear', () => {
    it('should remove all routes', () => {
      registry.register('GET', '/users', 0);
      registry.register('POST', '/users', 1);

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
