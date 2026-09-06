import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type {
  ComponentNode, RouteGuard, RouteGuards, RouteNode, SourcePointer,
} from '@ui-manifest-json/core';
import type { AngularExtractConfig } from './config.js';
import { objectLiteralProps, parseSourceText, toRepoRelative } from './component-parser.js';

export interface RouteParseResult {
  routes: RouteNode[];
  diagnostics: string[];
}

/** Components already collected (by `component-parser.ts`), indexed for resolving route targets
 *  that don't spell out an export name themselves — see `extractLoadComponentTarget` and
 *  `extractEagerComponentTarget`. Optional everywhere (defaults to empty): route-parsing can
 *  always run standalone, it just leaves those specific shapes as diagnosed-but-unresolved
 *  without it, same as before this lookup existed. */
export interface ComponentLookup {
  /** Keyed by `ComponentNode.filePath` (repo-relative, matching `toRepoRelative`'s convention). */
  byFilePath: Map<string, ComponentNode>;
  /** Keyed by `ComponentNode.className`. */
  byClassName: Map<string, ComponentNode>;
}

export function emptyComponentLookup(): ComponentLookup {
  return { byFilePath: new Map(), byClassName: new Map() };
}

export function buildComponentLookup(components: ComponentNode[]): ComponentLookup {
  const lookup = emptyComponentLookup();
  for (const c of components) {
    lookup.byFilePath.set(c.filePath, c);
    lookup.byClassName.set(c.className, c);
  }
  return lookup;
}

interface RouteParseContext {
  /** Absolute path of the file `routeObjectToPlain` is currently walking route objects from —
   *  changes as `loadChildren` recurses into another file. Relative specifiers (`loadComponent`,
   *  `loadChildren`) resolve against THIS, not the top-level routes file. */
  currentFilePath: string;
  cwd: string;
  lookup: ComponentLookup;
  /** Absolute paths of routes files currently being expanded via `loadChildren`, on the active
   *  recursion path — cycle guard, mirroring the dependency-graph resolver's path-scoped
   *  approach: a routes file legitimately reachable via multiple sibling `loadChildren` is fine,
   *  only a file re-appearing in its OWN ancestor chain is a cycle. */
  activeRouteFiles: Set<string>;
  diagnostics: string[];
}

function exprToPlain(node: ts.Expression | undefined, sourceFile: ts.SourceFile): unknown {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(el => exprToPlain(el, sourceFile));
  }
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

/** Pull a bare `import('./x')` module specifier out of an expression's source text — no
 *  `.then(...)` required. Shared by the modern default-export `loadComponent` form and by
 *  `loadChildren`, which is always written this way (no `.then()` — the imported module's
 *  `routes`/default export IS the child route array). */
function extractBareImportSpecifier(text: string): string | undefined {
  const match = text.match(/import\(\s*(['"`])([^'"`]+)\1\s*\)/);
  return match?.[2];
}

const CANDIDATE_EXTENSIONS = ['.ts', '.tsx'];

/** Resolve a relative module specifier (from `fromFilePath`) to a real file on disk, trying the
 *  specifier as-is and with `.ts`/`.tsx` appended. Bare/npm specifiers are out of scope — this is
 *  syntactic resolution only, no module-resolution host, same posture as the rest of this
 *  package. */
function resolveModuleFile(fromFilePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolvePath(dirname(fromFilePath), specifier);
  const candidates = [base, ...CANDIDATE_EXTENSIONS.map(ext => base + ext)];
  return candidates.find(existsSync);
}

/**
 * Match `loadComponent`'s two real shapes:
 *   1. `import('./x').then(m => m.Y)` — unambiguous, export name spelled out.
 *   2. `import('./x')` alone (no `.then()`) — the modern default-export convention (Angular CLI
 *      generates this form). The export name isn't written anywhere in the route config itself,
 *      so it's resolved by matching the specifier's target FILE against the already-collected
 *      `components[]` (via `lookup.byFilePath`) rather than by re-parsing the target file's own
 *      export statement — this is why route-parsing now needs the component lookup at all.
 *
 * `RouteNode.component` has no fallback shape for anything else (unlike the original prototype's
 * `{raw: text}`) — an unresolved expression is recorded as a diagnostic and `component` is left
 * unset, since the fixed core schema has nowhere else to put it.
 */
function extractLoadComponentTarget(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  ctx: RouteParseContext,
): { module: string; export: string } | undefined {
  const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();

  const thenMatch = text.match(/import\(\s*(['"`])([^'"`]+)\1\s*\)\s*\.then\(\s*\(?\s*m\s*\)?\s*=>\s*m\.(\w+)/);
  if (thenMatch) {
    return { module: thenMatch[2], export: thenMatch[3] };
  }

  const bareSpecifier = extractBareImportSpecifier(text);
  if (bareSpecifier) {
    const resolvedFile = resolveModuleFile(ctx.currentFilePath, bareSpecifier);
    const matched = resolvedFile ? ctx.lookup.byFilePath.get(toRepoRelative(resolvedFile, ctx.cwd)) : undefined;
    if (matched) {
      return { module: bareSpecifier, export: matched.className };
    }
    ctx.diagnostics.push(`unresolved loadComponent target (no matching component found for "${bareSpecifier}"): ${text}`);
    return undefined;
  }

  ctx.diagnostics.push(`unresolved loadComponent target: ${text}`);
  return undefined;
}

/**
 * Match the older, eager `component: SomeComponent` route shape (a direct class reference, no
 * dynamic `import()` at all — still valid Angular Router syntax, just not the lazy-loading
 * convention). Resolved by looking `SomeComponent` up directly in `lookup.byClassName` — Angular
 * class names are conventionally unique across an app, so no import-statement resolution is
 * needed the way `loadComponent`'s bare form requires. `module` is set to the matched component's
 * own `filePath` (there's no import specifier to report for an eager reference in the general
 * case — same-file or re-exported — so the resolved file path is the more useful, always-correct
 * value here, unlike `loadComponent`'s `module`, which mirrors the literal specifier text).
 */
function extractEagerComponentTarget(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  ctx: RouteParseContext,
): { module: string; export: string } | undefined {
  if (!ts.isIdentifier(node)) {
    ctx.diagnostics.push(`unresolved eager component target: ${node.getText(sourceFile).replace(/\s+/g, ' ').trim()}`);
    return undefined;
  }
  const matched = ctx.lookup.byClassName.get(node.text);
  if (matched) {
    return { module: matched.filePath, export: matched.className };
  }
  ctx.diagnostics.push(`unresolved eager component target: no matching component found for "${node.text}"`);
  return undefined;
}

/** Find the `Routes` array a routes file exports, however it's exported — the two shapes seen in
 *  practice: a top-level `export const routes: Routes = [...]` (or `const routes = [...]` with a
 *  separate `export default routes;` below it — this still finds it, since it matches by variable
 *  name regardless of how/whether it's separately exported), or a route array passed directly to
 *  `export default [...]` with no intermediate named variable at all. */
function findRoutesArray(sourceFile: ts.SourceFile): ts.ArrayLiteralExpression | undefined {
  let namedRoutesArray: ts.ArrayLiteralExpression | undefined;
  let defaultExportArray: ts.ArrayLiteralExpression | undefined;
  let defaultExportIdentifierName: string | undefined;

  ts.forEachChild(sourceFile, node => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === 'routes' &&
          decl.initializer &&
          ts.isArrayLiteralExpression(decl.initializer)
        ) {
          namedRoutesArray = decl.initializer;
        }
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      if (ts.isArrayLiteralExpression(expr)) {
        defaultExportArray = expr;
      } else if (ts.isIdentifier(expr)) {
        defaultExportIdentifierName = expr.text;
      }
    }
  });

  if (namedRoutesArray && (!defaultExportIdentifierName || defaultExportIdentifierName === 'routes')) {
    return namedRoutesArray;
  }
  return defaultExportArray ?? namedRoutesArray;
}

/** A 1-based line pointer into whichever file this route object is written in. */
function pointerAt(node: ts.Node, sourceFile: ts.SourceFile, ctx: RouteParseContext, symbol?: string): SourcePointer {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path: toRepoRelative(ctx.currentFilePath, ctx.cwd),
    ...(symbol ? { symbol } : {}),
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function routeObjectToPlain(objLiteral: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile, ctx: RouteParseContext): RouteNode {
  const props = objectLiteralProps(objLiteral);

  const pathValue = props.has('path') ? exprToPlain(props.get('path'), sourceFile) : undefined;
  const route: RouteNode = { path: typeof pathValue === 'string' ? pathValue : '' };

  if (props.has('redirectTo')) {
    const v = exprToPlain(props.get('redirectTo'), sourceFile);
    if (typeof v === 'string') route.redirectTo = v;
  }
  if (props.has('pathMatch')) {
    const v = exprToPlain(props.get('pathMatch'), sourceFile);
    if (typeof v === 'string') route.pathMatch = v;
  }

  if (props.has('loadComponent')) {
    const target = extractLoadComponentTarget(props.get('loadComponent') as ts.Expression, sourceFile, ctx);
    if (target) route.component = target;
  } else if (props.has('component')) {
    const target = extractEagerComponentTarget(props.get('component') as ts.Expression, sourceFile, ctx);
    if (target) route.component = target;
  }

  const guards: RouteGuards = {};
  for (const key of ['canActivate', 'canActivateChild', 'canDeactivate', 'canMatch'] as const) {
    if (props.has(key)) {
      const val = props.get(key) as ts.Expression;
      if (ts.isArrayLiteralExpression(val)) {
        guards[key] = val.elements.map((el): RouteGuard => {
          const name = el.getText(sourceFile).replace(/\s+/g, ' ').trim();
          // A guard reference in a route array is an identifier, not a declaration — the
          // declaration is in another file this pass never opens. Point at the REFERENCE and say
          // so by naming the symbol: "somewhere called authGuard, referenced here" is a usable
          // answer, where a pointer invented for the declaration would be a wrong one.
          return {
            name,
            kind: /^[A-Z]/.test(name) ? 'class' : 'function',
            source: pointerAt(el, sourceFile, ctx, /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined),
          };
        });
      }
    }
  }
  if (Object.keys(guards).length) route.guards = guards;

  if (props.has('children')) {
    const val = props.get('children') as ts.Expression;
    if (ts.isArrayLiteralExpression(val)) {
      route.children = val.elements.filter(ts.isObjectLiteralExpression).map(el => routeObjectToPlain(el, sourceFile, ctx));
    }
  } else if (props.has('loadChildren')) {
    route.children = resolveLoadChildren(props.get('loadChildren') as ts.Expression, sourceFile, ctx);
  }

  route.source = pointerAt(objLiteral, sourceFile, ctx);

  return route;
}

function resolveLoadChildren(node: ts.Expression, sourceFile: ts.SourceFile, ctx: RouteParseContext): RouteNode[] | undefined {
  const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
  const specifier = extractBareImportSpecifier(text);
  if (!specifier) {
    ctx.diagnostics.push(`unresolved loadChildren target: ${text}`);
    return undefined;
  }

  const resolvedFile = resolveModuleFile(ctx.currentFilePath, specifier);
  if (!resolvedFile) {
    ctx.diagnostics.push(`unresolved loadChildren target (file not found for "${specifier}"): ${text}`);
    return undefined;
  }
  if (ctx.activeRouteFiles.has(resolvedFile)) {
    ctx.diagnostics.push(`loadChildren cycle detected, not expanding further: ${specifier} (from ${toRepoRelative(ctx.currentFilePath, ctx.cwd)})`);
    return undefined;
  }

  let childSourceText: string;
  try {
    childSourceText = readFileSync(resolvedFile, 'utf8');
  } catch {
    ctx.diagnostics.push(`unresolved loadChildren target (could not read "${specifier}"): ${text}`);
    return undefined;
  }

  const childSourceFile = parseSourceText(childSourceText, resolvedFile);
  const routesArray = findRoutesArray(childSourceFile);
  if (!routesArray) {
    ctx.diagnostics.push(`loadChildren target has no routes array: ${specifier} (resolved to ${toRepoRelative(resolvedFile, ctx.cwd)})`);
    return undefined;
  }

  const childCtx: RouteParseContext = {
    ...ctx,
    currentFilePath: resolvedFile,
    activeRouteFiles: new Set([...ctx.activeRouteFiles, resolvedFile]),
  };
  return routesArray.elements.filter(ts.isObjectLiteralExpression).map(el => routeObjectToPlain(el, childSourceFile, childCtx));
}

/** Parse a `routes: Routes = [...]` array out of an already-in-memory TS source string.
 *  Exported (in addition to the file-driven {@link collectRoutes}) so unit tests can feed small
 *  inline source strings without touching disk. `lookup`/`cwd` are optional — omitting them just
 *  means the modern default-export `loadComponent` form and eager `component:` targets stay
 *  diagnosed-but-unresolved, same as if no matching component existed. */
export function collectRoutesFromSource(
  sourceText: string,
  fileName: string,
  lookup: ComponentLookup = emptyComponentLookup(),
  cwd: string = dirname(fileName),
): RouteParseResult {
  const diagnostics: string[] = [];
  const sourceFile = parseSourceText(sourceText, fileName);
  const routesArray = findRoutesArray(sourceFile);
  if (!routesArray) return { routes: [], diagnostics };

  const ctx: RouteParseContext = {
    currentFilePath: fileName,
    cwd,
    lookup,
    activeRouteFiles: new Set([fileName]),
    diagnostics,
  };
  const routes = routesArray.elements.filter(ts.isObjectLiteralExpression).map(el => routeObjectToPlain(el, sourceFile, ctx));
  return { routes, diagnostics };
}

/** Read and parse `config.routesFile`'s `routes` array, resolving `loadComponent`'s modern
 *  default-export form, eager `component:` targets, and `loadChildren` recursion against
 *  `lookup` (built from the already-collected `components[]` — see `buildComponentLookup`). */
export function collectRoutes(config: AngularExtractConfig, lookup: ComponentLookup): RouteParseResult {
  const text = readFileSync(config.routesFile, 'utf8');
  return collectRoutesFromSource(text, config.routesFile, lookup, config.cwd);
}
