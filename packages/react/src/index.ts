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
    if (!filePath.endsWith('.tsx') && !filePath.endsWith('.jsx')) continue; // JSX only parses in these
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

  if (config.dependencyGraph) {
    const { componentIndex, sameFileIndex } = buildComponentIndex(indexableComponents);
    const ctx: ResolveContext = { files, componentIndex, sameFileIndex };
    const trees: RouteDependencyTree[] = [];
    // One matchFn, reused across every route: it's context-aware (reads the "current" component's
    // own filePath on each call, passed through by core's resolveRouteDependencyTree), so it isn't
    // tied to any single route's root file the way a pre-bound version would be.
    const matchFn = createMatchFn(ctx);

    const visitRoute = (route: RouteNode, definingFile: string): void => {
      if (route.component) {
        const rootNode = resolveJsxTagToComponent(route.component.export, definingFile, ctx);
        if (rootNode) {
          trees.push(resolveRouteDependencyTree(route.path, rootNode, matchFn));
        }
      }
      route.children?.forEach(child => visitRoute(child, definingFile));
    };

    for (const { filePath, result } of routeResultsByFile) {
      result.routes.forEach(route => visitRoute(route, filePath));
    }

    manifest.dependencyGraph = trees;
  }

  return manifest;
}
