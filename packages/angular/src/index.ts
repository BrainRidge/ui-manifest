/**
 * @ui-manifest-json/angular — extracts routes, components, and (optionally) template DOM /
 * dependency-graph trees from an Angular app's `src/app/` directory.
 *
 * Why source-derived extraction: this is a syntactic pass over each `*.component.ts` (via the
 * `typescript` package's AST — no type-checker `Program`, no `tsc` project load) and over the
 * `Routes` array in `app.routes.ts`. It never runs the target app or its build; it never needs a
 * tsconfig, node_modules to be installed, or a compiling project. That makes it fast and safe to
 * run against arbitrary/partially-broken Angular codebases, at the cost of anything that isn't
 * visible syntactically (e.g. a type-only import re-exported through a barrel, or an input whose
 * type can only be resolved by the checker) being left out rather than guessed at.
 *
 * What `--with-dom` adds: each component's template (inline or external `templateUrl`) is parsed
 * with `@angular/compiler`'s real Ivy `parseTemplate()` — the same production parser Angular's own
 * compiler uses — into a `DomNode[]` tree (`ComponentNode.dom`). This is a real grammar, not a
 * heuristic: every node it emits is honestly marked `extraction: "compiler"`. Because
 * `@angular/compiler` is a fairly large optional peer dependency, it is imported lazily (dynamic
 * `import()`) only when `--with-dom` is actually passed, so base route/component extraction never
 * pays for it and works even when `@angular/compiler` isn't installed at all.
 *
 * What `--dependency-graph` adds: for every route with a resolvable `loadComponent` target, its
 * component's `dom` tree is walked and every element whose tag matches another known component's
 * selector is spliced in place with that component's own (recursively resolved) template —
 * producing one `RouteDependencyTree` per route, annotated with component-boundary and
 * cycle-detection markers. The splicing/cycle-detection algorithm itself lives in
 * `@ui-manifest-json/core`'s `resolveRouteDependencyTree`; this package only supplies the
 * selector-based `matchFn`. Requires `--with-dom`, since there is no `dom` tree to walk otherwise.
 *
 * `typescript` peer range is capped at `<6.0.0` DELIBERATELY, not an oversight — TypeScript 7.x is
 * Microsoft's native (Go-based) compiler rewrite, and its `typescript` npm package's root export
 * changed from the classic CJS compiler API to `./lib/version.cjs` (just a version string). Every
 * `import ts from 'typescript'` in this codebase — and the API shape it then calls
 * (`ts.createSourceFile`, `ts.SyntaxKind`, decorator/JSX AST walking) — assumes the classic 4.x/5.x
 * API. An unbounded `>=4.8.0` peer range let npm resolve TS7 as "compatible" and silently broke
 * every parse with `Cannot read properties of undefined (reading 'Latest')` — caught by installing
 * this package fresh from the registry (not the monorepo's own hoisted 5.x devDependency) before
 * release. Revisit this cap only alongside real TS7 API support, not by just widening the range.
 */
import type { UiManifest } from '@ui-manifest-json/core';
import {
  SCHEMA_VERSION,
  collectRepoProvenance,
  generatorProvenance,
  resolveFullPaths,
} from '@ui-manifest-json/core';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';
import { detectAppIdentity } from './app-identity.js';
import { collectComponents } from './component-parser.js';
import type { AngularExtractConfig, AngularExtractOptions } from './config.js';
import { resolveConfig } from './config.js';
import { buildDependencyGraph } from './resolve.js';
import { buildComponentLookup, collectRoutes } from './route-parser.js';

export type { AngularExtractConfig, AngularExtractOptions } from './config.js';
export { resolveConfig } from './config.js';

/** Run the full extraction pipeline (routes, components, and optionally their template DOM /
 *  dependency graph) and return a `UiManifest`. This is the package's one public entry point;
 *  `cli.ts` is a thin argv-parsing wrapper around it. */
export async function extract(options: AngularExtractOptions = {}): Promise<UiManifest> {
  const config: AngularExtractConfig = resolveConfig(options);
  const diagnostics: string[] = [];

  // Components are collected FIRST: route-parsing needs to resolve the modern default-export
  // `loadComponent: () => import('./x')` form (no `.then()`, no export name to read off the
  // route config itself — see route-parser.ts) and eager `component: X` targets against the
  // already-known component set.
  const { components, diagnostics: componentDiagnostics } = await collectComponents(config);
  diagnostics.push(...componentDiagnostics);

  const { routes, diagnostics: routeDiagnostics } = collectRoutes(config, buildComponentLookup(components));
  diagnostics.push(...routeDiagnostics);

  // Detected BEFORE fullPath resolution, because baseHref is part of every path it produces.
  const { app, diagnostics: appDiagnostics } = detectAppIdentity({
    targetDir: config.targetDir,
    cwd: config.cwd,
    overrides: { baseHref: config.baseHref, routerMode: config.routerMode },
  });
  diagnostics.push(...appDiagnostics);
  resolveFullPaths(routes, app.baseHref);

  const passes = ['routes', 'components'];
  if (config.withDom) passes.push('dom');
  if (config.dependencyGraph) passes.push('dependency-graph');

  const manifest: UiManifest = {
    schemaVersion: SCHEMA_VERSION,
    framework: 'angular',
    app,
    provenance: {
      repo: collectRepoProvenance({ targetDir: config.targetDir, cwd: config.cwd }),
      generator: generatorProvenance(PACKAGE_NAME, PACKAGE_VERSION, passes),
    },
    coverage: config.coverage,
    generatedAt: new Date().toISOString(),
    routes,
    components,
  };

  if (config.dependencyGraph) {
    const { dependencyGraph, diagnostics: graphDiagnostics } = buildDependencyGraph(routes, components);
    manifest.dependencyGraph = dependencyGraph;
    diagnostics.push(...graphDiagnostics);
  }

  if (diagnostics.length) manifest.diagnostics = diagnostics;

  return manifest;
}
