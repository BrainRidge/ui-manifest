/**
 * Resolve every route's `fullPath` from the nested route tree.
 *
 * Framework-agnostic on purpose: Angular's `children`/`loadChildren` and React Router's nested
 * `<Route>`/`children` produce the same `RouteNode` tree, so the join rule is the same and lives
 * once. Both extractors call this after their own parsing.
 */
import type { RouteNode } from './types/route.js';

/** Route paths that match anything and therefore identify nothing. */
const WILDCARDS = new Set(['**', '*']);

function join(parent: string, segment: string): string {
  const left = parent.replace(/\/+$/, '');
  const right = segment.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!right) return left || '/';
  return `${left}/${right}`;
}

/**
 * Annotate `routes` (in place, recursively) with `fullPath`.
 *
 * `baseHref` is prepended so the result is what a URL actually looks like, not what the route
 * config says — those differ for every app not served from the root, and the difference is
 * invisible until a consumer tries to match a real URL and matches nothing.
 *
 * A wildcard gets no `fullPath` at all rather than an empty or synthesised one: it is a fallback,
 * not a screen, and a consumer walking `fullPath` should skip it without having to know the
 * convention.
 *
 * Note a wildcard's CHILDREN are still resolved. A `**` with children is unusual but legal, and the
 * children are reachable even though the parent segment is not a location.
 */
export function resolveFullPaths(routes: RouteNode[], baseHref = '/'): RouteNode[] {
  const base = `/${baseHref.replace(/^\/+/, '').replace(/\/+$/, '')}`.replace(/^\/$/, '');
  const walk = (nodes: RouteNode[], parent: string): void => {
    for (const node of nodes) {
      const segment = node.path ?? '';
      const here = WILDCARDS.has(segment.trim()) ? parent : join(parent, segment);
      if (!WILDCARDS.has(segment.trim())) node.fullPath = here || '/';
      if (node.children?.length) walk(node.children, here);
    }
  };
  walk(routes, base);
  return routes;
}
