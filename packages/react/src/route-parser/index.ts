/**
 * # React extraction limits
 *
 * React Router (imported from either `react-router-dom` or the base `react-router` package — see
 * `ROUTER_MODULE_SPECIFIERS` below) supports two real routing patterns, and there is no way to
 * tell which one an app uses from `package.json` alone — this dispatcher looks at actual
 * router-setup source, per file, trying each in order:
 *
 *   1. `router-config` — a `createBrowserRouter`/`createHashRouter`/`createMemoryRouter` call
 *      whose argument is a route-object array literal (v6.4+/v7; see `router-config.ts`).
 *   2. `jsx-routes` — a JSX route table: `<Routes>...<Route/>...</Routes>` on v6/v7, or
 *      `<Switch>...<Route/>...</Switch>` (and bare `<Route>`s) on v3/v4/v5, optionally nested
 *      inside `<BrowserRouter>`/`<HashRouter>` (see `jsx-routes.ts`). Both spell the route's
 *      target differently — `element={<X/>}` on v6/v7, `component={X}`/`render={() => <X/>}` on
 *      v3/v4/v5 — and all three forms are read.
 *
 * A file that imports a route-DEFINING name from `react-router-dom`/`react-router` (see
 * `ROUTE_DEFINING_IMPORTS`) but matches NEITHER pattern contributes an empty route list plus a
 * `diagnostics` entry naming the file — never a silent empty result that would be
 * indistinguishable from "this file genuinely defines zero routes." A file importing react-router
 * only to navigate (`Link`, `withRouter`, `useNavigate`) defines no route table and so gets
 * neither routes nor a diagnostic.
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
import type { RouteNode } from '@ui-manifest-json/core';
import { parseRouterConfigRoutes } from './router-config.js';
import { parseJsxRoutes } from './jsx-routes.js';

export type { ReactRoutingPattern } from '@ui-manifest-json/core';

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

/**
 * The imports that say "this file DEFINES routes", as opposed to merely navigating between them.
 *
 * Most files in a real app that import react-router import `Link`, `NavLink`, `withRouter`,
 * `useNavigate`, `useParams` or `Redirect` — a header, a login form, a modal. Those files define
 * no route table, so there is no routing pattern to resolve and nothing to report; treating a
 * bare react-router import as routing intent produced one "routing pattern unresolved" diagnostic
 * for every such file, which on a mid-sized app buries the handful of real ones under dozens of
 * false alarms and makes `diagnostics` useless as a signal. `docs/schema.md` promises the
 * opposite: a diagnostic about a file means that file's contribution is incomplete.
 *
 * This gates the DIAGNOSTIC only, never the parse — every file importing react-router is still
 * offered to both strategies below, so a narrowed set here can lose a false alarm but never a
 * route.
 */
const ROUTE_DEFINING_IMPORTS = new Set([
  'Route',
  'Routes',
  'Switch',
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
  'createRoutesFromElements',
]);

interface RouterImportUsage {
  /** Whether the file imports from react-router / react-router-dom at all. */
  present: boolean;
  /** Whether any imported name is one of `ROUTE_DEFINING_IMPORTS`. */
  definesRoutes: boolean;
}

function routerImportUsage(sourceFile: ts.SourceFile): RouterImportUsage {
  const usage: RouterImportUsage = { present: false, definesRoutes: false };

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!ROUTER_MODULE_SPECIFIERS.has(stmt.moduleSpecifier.text)) continue;
    usage.present = true;

    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (ROUTE_DEFINING_IMPORTS.has((el.propertyName ?? el.name).text)) usage.definesRoutes = true;
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      // `import * as Router from 'react-router-dom'` — which names get used is not knowable from
      // the import declaration alone, so stay on the noisy side and keep the file a candidate.
      usage.definesRoutes = true;
    }
  }

  return usage;
}

/** Try each detection strategy, in order, for one source file. */
export function parseRoutesInFile(sourceFile: ts.SourceFile, filePath: string): RouteParseResult {
  const usage = routerImportUsage(sourceFile);
  if (!usage.present) {
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

  if (!usage.definesRoutes) {
    return { routes: [], diagnostics: [] }; // navigation-only usage — genuinely zero routes here
  }

  return { routes: [], diagnostics: [`routing pattern unresolved for ${filePath}`] };
}

export { parseRouterConfigRoutes } from './router-config.js';
export { parseJsxRoutes } from './jsx-routes.js';
export { parseFileBasedRoutes } from './file-based.js';
