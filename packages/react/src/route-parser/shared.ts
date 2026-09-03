import ts from 'typescript';
import type { RouteNode } from '@ui-manifest-json/core';
import { findImportBinding, isJsxLike, unwrapParens } from '../ts-utils.js';

/**
 * Resolve an identifier naming a route's target component (however it was referenced — a JSX tag
 * in `element={<X/>}`, or a direct reference in the newer `Component: X` shorthand) into
 * `RouteNode['component']`: the import source specifier that binds it (`module`) — NOT a
 * filesystem-resolved path — and the identifier itself (`export`). Deep resolution (extension/
 * index resolution, barrel chasing, default-vs-named disambiguation) is `resolve.ts`'s job when
 * building the dependency graph; this is purely descriptive output for the route tree itself.
 *
 * When `X` isn't imported (defined in the same file as the router setup), `module` falls back to
 * the current file's own path so the field is never silently empty.
 */
export function resolveComponentIdentifier(
  identifierName: string,
  sourceFile: ts.SourceFile,
  currentFilePath: string,
): NonNullable<RouteNode['component']> {
  const binding = findImportBinding(sourceFile, identifierName);
  return { module: binding?.moduleSpecifier ?? currentFilePath, export: identifierName };
}

/** JSX's own rule for telling a DOM element from a component reference: a tag starting with a
 *  lowercase letter is ALWAYS a built-in host element (`<h2>`, `<div>`, `<span>`, ...), never a
 *  component — this isn't a heuristic, it's how JSX itself resolves tags at compile time. Without
 *  this check, `element={<h2>Index</h2>}` (a real shape found in react-router's own official
 *  examples) would be misreported as a route resolving to a component literally named "h2". */
function isLowercaseHostTag(tagName: string): boolean {
  return /^[a-z]/.test(tagName);
}

/** The JSX-tag form: `element={<X .../>}`. Unwraps to the tag name, then defers to
 *  `resolveComponentIdentifier` — see its docs for the resolution rules. Returns undefined for a
 *  lowercase host element (`<h2>`, `<div>`, ...): that's real, renderable JSX, just not a
 *  component reference, so there's nothing to resolve. */
export function resolveElementComponent(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  currentFilePath: string,
): RouteNode['component'] | undefined {
  const u = unwrapParens(expr);
  if (!isJsxLike(u) || ts.isJsxFragment(u)) return undefined;
  const tagNameNode = ts.isJsxElement(u) ? u.openingElement.tagName : u.tagName;
  const tagName = tagNameNode.getText(sourceFile);
  if (isLowercaseHostTag(tagName)) return undefined;
  return resolveComponentIdentifier(tagName, sourceFile, currentFilePath);
}

/** A route entry is worth emitting once it carries ANY recognizable route information — a
 *  pathless layout route (`element` + `children`, no `path`) and an `index` route (no `path` by
 *  definition) are both legitimate react-router-dom v6/v7 constructs. Since `RouteNode.path` is
 *  required by the shared schema, both map to `path: ''` — the closest honest representation of
 *  "no additional path segment", documented here rather than silently invented per call site. */
export const PATHLESS_ROUTE_PATH = '';
