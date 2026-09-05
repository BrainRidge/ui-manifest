import { resolve } from 'node:path';

/** Options accepted by {@link resolveConfig} / the public {@link extract} API. Every field is
 *  optional and defaults the same way the CLI flags described in the package README do. */
export interface AngularExtractOptions {
  /** Directory to scan for `*.component.ts` files, resolved relative to `cwd`. Default: "src/app". */
  targetDir?: string;
  /**
   * Routes file to parse for the `routes` array, resolved relative to `targetDir` — NOT to `cwd`
   * or a repo root. This intentionally matches the original prototype's
   * `ROUTES_FILE = resolve(APP_ROOT, 'app.routes.ts')`. Default: "app.routes.ts".
   */
  routesFile?: string;
  /** Parse every component's template via `@angular/compiler`'s real Ivy `parseTemplate()`.
   *  `@angular/compiler` is only imported (lazily) when this is true. Default: false. */
  withDom?: boolean;
  /** Resolve route -> component dependency trees via `@ui-manifest-json/core`'s
   *  `resolveRouteDependencyTree`. Requires `withDom` — see {@link resolveConfig}. Default: false. */
  dependencyGraph?: boolean;
  /** Working directory `targetDir` is resolved against, and the base every `ComponentNode.filePath`
   *  in the output is made relative to. Default: `process.cwd()`. */
  cwd?: string;
  /** Override the detected `<base href>`. Supply this when the app is served from a subpath the
   *  source does not state — a reverse proxy, or a base href injected at deploy time. */
  baseHref?: string;
  /** Override the detected router mode (`"path"` | `"hash"`). */
  routerMode?: 'path' | 'hash';
  /**
   * Whether this run covers the whole app (`"full"`, the default) or a named part of it
   * (`"partial"`). Only a `"full"` manifest licenses a consumer to read a route's ABSENCE as
   * deletion; declaring `"partial"` when scanning a subtree is what stops a merge from silently
   * dropping every route the run did not look at.
   */
  coverage?: 'full' | 'partial';
}

/** Fully-resolved configuration: every path absolute, every flag defaulted. */
export interface AngularExtractConfig {
  targetDir: string;
  routesFile: string;
  withDom: boolean;
  dependencyGraph: boolean;
  cwd: string;
  baseHref?: string;
  routerMode?: 'path' | 'hash';
  coverage: 'full' | 'partial';
}

/**
 * Resolve user-supplied options into a complete, absolute-path configuration.
 *
 * Throws if `dependencyGraph` is requested without `withDom` — dependency-graph resolution walks
 * each component's `dom`, which only exists when template parsing ran, so silently returning an
 * empty `dependencyGraph` would hide a usage mistake rather than surface it.
 */
export function resolveConfig(options: AngularExtractOptions = {}): AngularExtractConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const targetDir = resolve(cwd, options.targetDir ?? 'src/app');
  const routesFile = resolve(targetDir, options.routesFile ?? 'app.routes.ts');
  const withDom = options.withDom ?? false;
  const dependencyGraph = options.dependencyGraph ?? false;

  if (dependencyGraph && !withDom) {
    throw new Error('--dependency-graph requires --with-dom');
  }

  return {
    targetDir, routesFile, withDom, dependencyGraph, cwd,
    baseHref: options.baseHref,
    routerMode: options.routerMode,
    coverage: options.coverage ?? 'full',
  };
}
