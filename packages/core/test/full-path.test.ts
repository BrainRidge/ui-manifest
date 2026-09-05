import { describe, expect, it } from 'vitest';
import { resolveFullPaths } from '../src/full-path.js';
import type { RouteNode } from '../src/types/route.js';

const r = (path: string, children?: RouteNode[]): RouteNode =>
  children ? { path, children } : { path };

describe('resolveFullPaths', () => {
  it('joins parent segments so nested routes are addressable', () => {
    const routes = [r('accounts', [r(''), r(':id'), r(':id/history')])];
    resolveFullPaths(routes);
    expect(routes[0].fullPath).toBe('/accounts');
    expect(routes[0].children!.map(c => c.fullPath))
      .toEqual(['/accounts', '/accounts/:id', '/accounts/:id/history']);
  });

  it("distinguishes two '' children that would otherwise collide", () => {
    // The specific mistake this field exists to prevent: keying on `path` alone makes the index
    // route of every feature the same route.
    const routes = [r('accounts', [r('')]), r('settings', [r('')])];
    resolveFullPaths(routes);
    const indexes = routes.map(x => x.children![0].fullPath);
    expect(indexes).toEqual(['/accounts', '/settings']);
    expect(new Set(indexes).size).toBe(2);
  });

  it('applies baseHref, because that is what a real URL looks like', () => {
    // An app served under /portal/ renders /portal/dashboard. A manifest that says /dashboard
    // matches no URL the app ever produces, on every route, without erroring.
    const routes = [r('dashboard')];
    resolveFullPaths(routes, '/portal/');
    expect(routes[0].fullPath).toBe('/portal/dashboard');
  });

  it.each(['/', '', '///'])('treats %j as the root', (base) => {
    const routes = [r('login')];
    resolveFullPaths(routes, base);
    expect(routes[0].fullPath).toBe('/login');
  });

  it('gives a wildcard no fullPath, because it is a fallback and not a screen', () => {
    const routes = [r('login'), r('**')];
    resolveFullPaths(routes);
    expect(routes[0].fullPath).toBe('/login');
    expect(routes[1].fullPath).toBeUndefined();
  });

  it("still resolves a wildcard's children, which are reachable even though it is not", () => {
    const routes = [r('**', [r('detail')])];
    resolveFullPaths(routes);
    expect(routes[0].fullPath).toBeUndefined();
    expect(routes[0].children![0].fullPath).toBe('/detail');
  });

  it('normalises slashes rather than producing doubled ones', () => {
    const routes = [r('/accounts/', [r('/:id/')])];
    resolveFullPaths(routes, '/portal');
    expect(routes[0].fullPath).toBe('/portal/accounts');
    expect(routes[0].children![0].fullPath).toBe('/portal/accounts/:id');
  });

  it('resolves the root route to "/" rather than the empty string', () => {
    const routes = [r('')];
    resolveFullPaths(routes);
    expect(routes[0].fullPath).toBe('/');
  });
});
