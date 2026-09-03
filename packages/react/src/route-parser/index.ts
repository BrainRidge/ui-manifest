/**
 * # React extraction limits
 *
 * React Router v6/v7 (imported from either `react-router-dom` or the base `react-router` package
 * — see `ROUTER_MODULE_SPECIFIERS` below) supports two real routing patterns, and there is no way
 * to tell which one an app uses from `package.json` alone — this dispatcher looks at actual
 * router-setup source, per file, trying each in order:
 *
 *   1. `router-config` — a `createBrowserRouter`/`createHashRouter`/`createMemoryRouter` call
 *      whose argument is a route-object array literal (see `router-config.ts`).
 *   2. `jsx-routes` — a `<Routes>...<Route/>...</Routes>` JSX tree, optionally nested inside
 *      `<BrowserRouter>`/`<HashRouter>` (see `jsx-routes.ts`).
 *
 * A file that imports from `react-router-dom`/`react-router` but matches NEITHER pattern
 * contributes an empty route list plus a `diagnostics` entry naming the file — never a silent
 * empty result that would be indistinguishable from "this file genuinely defines zero routes."
 *
 * **Explicit, deliberate gap**: Next.js file-based routing (the `app/`/`pages/` directory
 * convention) is NOT implemented in this pass. `file-based.ts` is a documented stub that throws
 * if ever invoked; `routingPattern: 'file-based'` is reserved on `ReactRoutingPattern` so the
 * schema doesn't need to change when that gap is eventually closed, but no directory-walk route
 * inference happens here — this dispatcher never calls into it.
 *
 * **Other known limits**: nav-blocking detection (`guards.canDeactivate`, `router-config` only)
 * is best-effort text, not a resolved guard, and only looks within the router-setup file itself
 * — see `router-config.ts`'s `detectNavBlocking` for the exact shapes recognized.
 */
import ts from 'typescript';
import type { RouteNode } from '@ui-manifest/core';
import { parseRouterConfigRoutes } from './router-config.js';
import { parseJsxRoutes } from './jsx-routes.js';

export type { ReactRoutingPattern } from '@ui-manifest/core';

export interface RouteParseResult {
  routes: RouteNode[];
  diagnostics: string[];
}

// As of React Router v6.4+ (and v7), the routing primitives (Routes/Route/createBrowserRouter/
// etc.) are exported from the base `react-router` package itself, with `react-router-dom` as a
// thinner DOM-specific wrapper re-exporting them — real apps (including react-router's OWN
// official examples) increasingly import directly from `react-router`, not `-dom`. Missing this
// isn't a rare edge case: it silently skipped every file in react-router's own `basic`,
// `data-router`, and `navigation-blocking` example apps during real-world verification.
const ROUTER_MODULE_SPECIFIERS = new Set(['react-router-dom', 'react-router']);

function importsReactRouter(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    stmt =>
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      ROUTER_MODULE_SPECIFIERS.has(stmt.moduleSpecifier.text),
  );
}

/** Try each detection strategy, in order, for one source file. */
export function parseRoutesInFile(sourceFile: ts.SourceFile, filePath: string): RouteParseResult {
  if (!importsReactRouter(sourceFile)) {
    return { routes: [], diagnostics: [] };
  }

  const routerConfigRoutes = parseRouterConfigRoutes(sourceFile, filePath);
  if (routerConfigRoutes.length > 0) {
    return { routes: routerConfigRoutes, diagnostics: [] };
  }

  const jsxRoutes = parseJsxRoutes(sourceFile, filePath);
  if (jsxRoutes.length > 0) {
    return { routes: jsxRoutes, diagnostics: [] };
  }

  return { routes: [], diagnostics: [`routing pattern unresolved for ${filePath}`] };
}

export { parseRouterConfigRoutes } from './router-config.js';
export { parseJsxRoutes } from './jsx-routes.js';
export { parseFileBasedRoutes } from './file-based.js';
