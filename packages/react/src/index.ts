import ts from 'typescript';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  collectRepoProvenance,
  generatorProvenance,
  resolveFullPaths,
  resolveRouteDependencyTree,
  type ComponentNode,
  type RouteDependencyTree,
  type RouteNode,
  type UiManifest,
} from '@ui-manifest-json/core';
import { resolveConfig, type ExtractConfig } from './config.js';
import { detectComponents } from './component-detector.js';
import { extractProps } from './props-parser.js';
import { buildDom } from './jsx-dom-parser.js';
import { parseRoutesInFile, type RouteParseResult } from './route-parser/index.js';
import { detectAppIdentity } from './app-identity.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';
import { buildComponentIndex, createMatchFn, resolveJsxTagToComponent, type IndexableComponent, type ResolveContext } from './resolve.js';

export type { ExtractConfig } from './config.js';
export { DEFAULT_CONFIG, resolveConfig } from './config.js';
export * from './component-detector.js';
export * from './props-parser.js';
export * from './jsx-dom-parser.js';
export * from './route-parser/index.js';
export * from './resolve.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[tj]sx?$/;

async function walkSourceFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // rootDir (or a subdir) doesn't exist / isn't readable — nothing to scan.
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.posix.extname(entry.name);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        if (entry.name.endsWith('.d.ts')) continue;
        if (TEST_FILE_RE.test(entry.name)) continue;
        results.push(full);
      }
    }
  }

  await walk(rootDir);
  return results;
}

function scriptKindForFile(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Extract routes, components, and (optionally) JSX DOM/dependency-graph trees from a React app's
 * source tree. Syntactic parsing only (TypeScript's own parser, no type checker `Program`) — same
 * posture as the `@ui-manifest-json/angular` extractor.
 *
 * `typescript` peer range is capped at `<6.0.0` DELIBERATELY — see the matching note in
 * `@ui-manifest-json/angular`'s `index.ts`. TypeScript 7.x's native (Go-based) rewrite restructured
 * the `typescript` npm package so its root export is no longer the classic compiler API every
 * `import ts from 'typescript'` in this codebase assumes; an unbounded peer range let npm resolve
 * TS7 as "compatible" and silently broke every parse.
 */
export async function extract(options: Partial<ExtractConfig> = {}): Promise<UiManifest> {
  const config = resolveConfig(options);
  // Absolute, because provenance asks git FROM the scanned tree — `--dir` can point at a checkout
  // that is not the one the command was run in, and asking about the process's cwd would pin the
  // manifest to an unrelated repository's HEAD while looking like a correct pin.
  const absDir = path.resolve(process.cwd(), config.dir);
  const filePaths = await walkSourceFiles(config.dir);

  const files = new Map<string, ts.SourceFile>();
  for (const filePath of filePaths) {
    const text = await fs.readFile(filePath, 'utf8');
    files.set(filePath, ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindForFile(filePath)));
  }

  const diagnostics: string[] = [];
  const indexableComponents: IndexableComponent[] = [];

  for (const [filePath, sourceFile] of files) {
    // Deliberately NOT an extension check. `.js` parses JSX perfectly well: `scriptKindForFile`
    // maps it to `ts.ScriptKind.JS`, which TypeScript resolves to `LanguageVariant.JSX` — the very
    // same variant `.jsx`/`.tsx` get — so the AST a `.js` component file yields is identical in
    // kind to a `.tsx` one. Only `.ts` genuinely cannot hold JSX (`<T>x` is a type assertion
    // there), and that is exactly what this test excludes.
    //
    // The old `.tsx`/`.jsx`-only filter therefore skipped every component in any Babel-compiled
    // app that writes plain `.js` — CRA, hand-rolled webpack, the whole pre-TS React world, which
    // is most long-lived React codebases. Nothing errored: the routes pass had no such filter, so
    // the manifest came out with routes beside `components: []` and an empty `dependencyGraph`,
    // and under `coverage: "full"` a consumer is licensed to read that as "this app has no
    // components at all".
    if (sourceFile.languageVariant !== ts.LanguageVariant.JSX) continue;
    const { components: detected, unnamedSkippedCount } = detectComponents(sourceFile);
    if (config.warnUnnamed && unnamedSkippedCount > 0) {
      diagnostics.push(`${unnamedSkippedCount} unnamed default-exported components skipped in ${filePath}`);
    }
    for (const dc of detected) {
      const node: ComponentNode = {
        className: dc.name,
        filePath,
        inputs: [],
        outputs: [],
        props: extractProps(dc, sourceFile),
      };
      if (config.withDom) {
        node.dom = buildDom(dc.primaryJsx, sourceFile);
      }
      indexableComponents.push({ node, isDefaultExport: dc.isDefaultExport });
    }
  }

  const routeResultsByFile: Array<{ filePath: string; result: RouteParseResult }> = [];
  for (const [filePath, sourceFile] of files) {
    routeResultsByFile.push({ filePath, result: parseRoutesInFile(sourceFile, filePath) });
  }

  const routes: RouteNode[] = [];
  for (const { result } of routeResultsByFile) {
    routes.push(...result.routes);
    diagnostics.push(...result.diagnostics);
  }

  // Detected BEFORE fullPath resolution, because basename is part of every path it produces. The
  // same files the route parser walked, so the router setup is found without a second pass.
  const app = detectAppIdentity({
    files,
    overrides: { baseHref: config.baseHref, routerMode: config.routerMode },
  });
  resolveFullPaths(routes, app.baseHref);

  const passes = ['routes', 'components'];
  if (config.withDom) passes.push('dom');
  if (config.dependencyGraph) passes.push('dependency-graph');

  // Runs BEFORE the manifest literal is built, so `diagnostics` is complete by the time it is
  // attached below — this pass appends entries of its own — and so the emitted key order stays
  // `diagnostics` then `dependencyGraph` for a manifest that is meant to diff cleanly.
  let dependencyGraph: RouteDependencyTree[] | undefined;
  if (config.dependencyGraph) {
    const { componentIndex, sameFileIndex } = buildComponentIndex(indexableComponents);
    const ctx: ResolveContext = { files, componentIndex, sameFileIndex };
    const trees: RouteDependencyTree[] = [];
    // One matchFn, reused across every route: it's context-aware (reads the "current" component's
    // own filePath on each call, passed through by core's resolveRouteDependencyTree), so it isn't
    // tied to any single route's root file the way a pre-bound version would be.
    const matchFn = createMatchFn(ctx);

    /**
     * Whether an unresolved route component is worth a diagnostic.
     *
     * Two shapes are unresolvable BY DESIGN, and reporting them would make the entry pure noise —
     * both turned up immediately on react-router's own v6 example apps:
     *
     *   - A bare module specifier. `element={<Outlet/>}` resolves `Outlet` to "react-router-dom";
     *     import resolution here is relative-specifier only (a documented limit — there is no
     *     module-resolution host, so npm packages and tsconfig path aliases are out of scope), and
     *     a router built-in has no app component to find to begin with.
     *   - A namespace-qualified tag. `element={<React.Suspense>...</React.Suspense>}` yields the
     *     export name "React.Suspense", a framework built-in reached through a namespace import,
     *     never something this extractor indexes as a component.
     *
     * What remains is the case the diagnostic exists for: a relative (or same-file) reference to a
     * plain identifier that should have resolved to a detected component and did not.
     */
    const isReportableUnresolved = (component: NonNullable<RouteNode['component']>): boolean => {
      if (component.export.includes('.')) return false;
      // `resolveComponentIdentifier` falls back to the defining file's own path when the
      // identifier isn't imported, so a same-file component's "module" is a scanned file, not a
      // specifier — hence the `files` check rather than only a leading-dot test.
      return component.module.startsWith('.') || files.has(component.module);
    };

    const visitRoute = (route: RouteNode, definingFile: string): void => {
      if (route.component) {
        const rootNode = resolveJsxTagToComponent(route.component.export, definingFile, ctx);
        if (rootNode) {
          trees.push(resolveRouteDependencyTree(route.path, rootNode, matchFn));
        } else if (isReportableUnresolved(route.component)) {
          // A route naming a component we could not resolve loses a whole tree from
          // `dependencyGraph`, and losing it silently is indistinguishable from a route whose
          // component genuinely renders nothing. `docs/schema.md` already promises this entry
          // ("a route pointing at a component that wasn't found") and the Angular extractor has
          // always emitted it; the React one just never did. Same wording, so one string greps
          // across both frameworks.
          //
          // Reachable for a barrel nested more than one level deep, and for a component shape
          // detection does not recognize — e.g. a class extending another component class rather
          // than React.Component. Emitted only under `--dependency-graph`, the pass that actually
          // attempts the resolution and where the loss has a visible consequence.
          diagnostics.push(
            `dependency graph: no component found for route "${route.path}" (export "${route.component.export}" from "${route.component.module}")`,
          );
        }
      }
      route.children?.forEach(child => visitRoute(child, definingFile));
    };

    for (const { filePath, result } of routeResultsByFile) {
      result.routes.forEach(route => visitRoute(route, filePath));
    }

    dependencyGraph = trees;
  }

  const manifest: UiManifest = {
    schemaVersion: SCHEMA_VERSION,
    framework: 'react',
    app,
    provenance: {
      repo: collectRepoProvenance({ targetDir: absDir, cwd: process.cwd() }),
      generator: generatorProvenance(PACKAGE_NAME, PACKAGE_VERSION, passes),
    },
    coverage: config.coverage,
    generatedAt: new Date().toISOString(),
    routes,
    components: indexableComponents.map(e => e.node),
  };


  if (diagnostics.length > 0) {
    manifest.diagnostics = diagnostics;
  }
  if (dependencyGraph) {
    manifest.dependencyGraph = dependencyGraph;
  }

  return manifest;
}
