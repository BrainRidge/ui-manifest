import ts from 'typescript';
import { readFileSync, statSync } from 'node:fs';
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve a relative module specifier (from `fromFilePath`) to a real file on disk: the specifier
 *  with `.ts`/`.tsx` appended, the specifier as-is, then `<specifier>/index.ts`. Bare/npm
 *  specifiers and tsconfig path aliases are out of scope — this is syntactic resolution only, no
 *  module-resolution host, same posture as the rest of this package.
 *
 *  Candidates are tested with `isFile`, not `existsSync`: a specifier like `./shared` next to a
 *  `shared/` DIRECTORY would otherwise resolve to the directory itself and every later read of it
 *  would throw, which reads downstream as "this module has no routes" — a wrong answer where
 *  falling through to `shared/index.ts` is the right one. */
function resolveModuleFile(fromFilePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolvePath(dirname(fromFilePath), specifier);
  const candidates = [
    ...CANDIDATE_EXTENSIONS.map(ext => base + ext),
    base,
    ...CANDIDATE_EXTENSIONS.map(ext => resolvePath(base, `index${ext}`)),
  ];
  return candidates.find(isFile);
}

function parseFileIfReadable(filePath: string): ts.SourceFile | undefined {
  try {
    return parseSourceText(readFileSync(filePath, 'utf8'), filePath);
  } catch {
    return undefined;
  }
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

/**
 * A routes array together with the file it is actually written in.
 *
 * The file is not bookkeeping: relative `loadComponent`/`loadChildren` specifiers inside those
 * routes resolve against IT, and so do their `source` pointers. For the NgModule shapes below that
 * is a DIFFERENT file from the one `loadChildren` named — `loans.module.ts` is what the route
 * config points at, `loans-routing.module.ts` is where the routes live and what `../funding/...`
 * inside them is relative to.
 */
interface LocatedRoutes {
  routesArray: ts.ArrayLiteralExpression;
  sourceFile: ts.SourceFile;
  filePath: string;
}

/** A top-level `const <name> = [...]` (annotated `: Routes` or not, exported or not). */
function findArrayVariable(sourceFile: ts.SourceFile, name: string): ts.ArrayLiteralExpression | undefined {
  let found: ts.ArrayLiteralExpression | undefined;
  ts.forEachChild(sourceFile, node => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === name &&
        decl.initializer &&
        ts.isArrayLiteralExpression(decl.initializer)
      ) {
        found = decl.initializer;
      }
    }
  });
  return found;
}

/** Where a locally-used name was imported from: the module specifier, and the name it is exported
 *  under THERE — `import { routes as featureRoutes }` means the sibling file declares `routes`,
 *  not `featureRoutes`. */
function findImportBinding(
  sourceFile: ts.SourceFile,
  localName: string,
): { specifier: string; exportedName: string } | undefined {
  let found: { specifier: string; exportedName: string } | undefined;
  ts.forEachChild(sourceFile, node => {
    if (found || !ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name && clause.name.text === localName) {
      found = { specifier, exportedName: 'default' };
      return;
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.name.text === localName) {
          found = { specifier, exportedName: element.propertyName?.text ?? element.name.text };
          return;
        }
      }
    }
  });
  return found;
}

/** Angular's two route-registration calls: `forRoot` in the app's root routing module, `forChild`
 *  in every lazy feature's. */
const ROUTER_MODULE_METHODS = new Set(['forRoot', 'forChild']);

/**
 * The first argument of a `RouterModule.forRoot(...)` / `RouterModule.forChild(...)` call anywhere
 * in the file — the call that actually hands a route table to the router.
 *
 * This is what makes a routing module findable regardless of what its array is NAMED.
 * `findPlainRoutesArray` below only knows the name `routes`, so an app that writes
 * `const appRoutes: Routes = [...]`, or passes the array inline, is invisible to it — and silently
 * so, which is the worse half: a routing module read as "has no routes" looks exactly like a
 * feature with no pages.
 */
function findRouterModuleRoutesArgument(sourceFile: ts.SourceFile): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'RouterModule' &&
      ROUTER_MODULE_METHODS.has(node.expression.name.text) &&
      node.arguments.length > 0
    ) {
      found = node.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/** Resolve whatever was passed to `RouterModule.forChild(...)` to a real array literal: written
 *  inline, declared as a local const, or imported from a sibling file. */
function resolveRoutesExpression(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  filePath: string,
): LocatedRoutes | undefined {
  if (ts.isArrayLiteralExpression(expr)) return { routesArray: expr, sourceFile, filePath };
  if (!ts.isIdentifier(expr)) return undefined;

  const local = findArrayVariable(sourceFile, expr.text);
  if (local) return { routesArray: local, sourceFile, filePath };

  // `import { routes } from './loans.routes'` — the module declares nothing, it re-registers an
  // array that lives next door.
  const binding = findImportBinding(sourceFile, expr.text);
  if (!binding) return undefined;
  const targetFile = resolveModuleFile(filePath, binding.specifier);
  if (!targetFile) return undefined;
  const targetSource = parseFileIfReadable(targetFile);
  if (!targetSource) return undefined;
  const named = binding.exportedName === 'default' ? undefined : findArrayVariable(targetSource, binding.exportedName);
  if (named) return { routesArray: named, sourceFile: targetSource, filePath: targetFile };
  const plain = findPlainRoutesArray(targetSource);
  return plain ? { routesArray: plain, sourceFile: targetSource, filePath: targetFile } : undefined;
}

/** Find the `Routes` array a routes file exports, however it's exported — the two shapes seen in
 *  practice: a top-level `export const routes: Routes = [...]` (or `const routes = [...]` with a
 *  separate `export default routes;` below it — this still finds it, since it matches by variable
 *  name regardless of how/whether it's separately exported), or a route array passed directly to
 *  `export default [...]` with no intermediate named variable at all. */
function findPlainRoutesArray(sourceFile: ts.SourceFile): ts.ArrayLiteralExpression | undefined {
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

/** Both ways a single file can state its routes, `RouterModule.forRoot/forChild(...)` first
 *  because that call is definitionally what the router receives, where the `routes` variable name
 *  is only a convention. */
function findRoutesInFile(sourceFile: ts.SourceFile, filePath: string): LocatedRoutes | undefined {
  const routerArgument = findRouterModuleRoutesArgument(sourceFile);
  if (routerArgument) {
    const located = resolveRoutesExpression(routerArgument, sourceFile, filePath);
    if (located) return located;
  }
  const plain = findPlainRoutesArray(sourceFile);
  return plain ? { routesArray: plain, sourceFile, filePath } : undefined;
}

/**
 * The module identifiers listed in this file's `@NgModule({ imports: [...] })`.
 *
 * Three element shapes, all of them load-bearing on real apps:
 *   - `SharedModule` — the plain identifier.
 *   - `NbDialogModule.forChild()` / `StoreModule.forFeature(...)` — the module is the call's base
 *     identifier; the call is just how it is configured.
 *   - `...MODULES` — a spread of an array declared above the decorator, expanded here by name.
 *     This is not a stylistic edge case: ngx-admin writes two of its twelve feature modules this
 *     way, and before this branch existed those two were the only ones whose routes this walk
 *     still missed — while the other ten resolved, which is what made it look like a pass.
 */
function ngModuleImportIdentifiers(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];

  const collect = (elements: readonly ts.Expression[], expandedSpreads: Set<string>): void => {
    for (const element of elements) {
      if (ts.isIdentifier(element)) {
        names.push(element.text);
      } else if (
        ts.isCallExpression(element) &&
        ts.isPropertyAccessExpression(element.expression) &&
        ts.isIdentifier(element.expression.expression)
      ) {
        names.push(element.expression.expression.text);
      } else if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
        // Guarded by name, not by depth: `const A = [...A]` is not valid, but an array naming
        // another that names it back would otherwise recurse forever.
        const spreadName = element.expression.text;
        if (expandedSpreads.has(spreadName)) continue;
        const array = findArrayVariable(sourceFile, spreadName);
        if (array) collect(array.elements, new Set([...expandedSpreads, spreadName]));
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'NgModule') {
      const imports = objectLiteralProps(node.arguments[0]).get('imports');
      if (imports && ts.isArrayLiteralExpression(imports)) collect(imports.elements, new Set());
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return names;
}

/** Resolve the subset of this file's relative imports whose local name is one of `names`, in
 *  source order, deduplicated. Bare specifiers (`@angular/common`, `rxjs`) resolve to nothing and
 *  drop out here, which is also what bounds the walk below to the app's own source. */
function importedModuleFiles(sourceFile: ts.SourceFile, filePath: string, names: Set<string>): string[] {
  const files: string[] = [];
  for (const name of names) {
    const binding = findImportBinding(sourceFile, name);
    if (!binding) continue;
    const resolved = resolveModuleFile(filePath, binding.specifier);
    if (resolved && !files.includes(resolved)) files.push(resolved);
  }
  return files;
}

/** How far the `imports:` walk below will chase a module graph. The Angular CLI's own layout puts
 *  the routing module one hop from the feature module; the extra hops cover an app that re-exports
 *  its routing module through an intermediate (a feature barrel, a shared wrapper module). Beyond
 *  that a hit is far more likely to be an unrelated module's route table than this feature's. */
const MAX_MODULE_IMPORT_DEPTH = 4;

/**
 * The fix for the shape this extractor used to miss entirely: a lazy `loadChildren` target that
 * holds no routes itself and imports a sibling `*-routing.module.ts` that calls
 * `RouterModule.forChild(routes)`. That is not an exotic layout — it is what
 * `ng generate module --routing` emits, so an NgModule-based app's ENTIRE page map below the
 * top level lived in files this parser never opened.
 *
 * Breadth-first over `@NgModule({ imports: [...] })` from the `loadChildren` target, stopping at
 * each module that yields a route table (its own imports are then that feature's business, and
 * any further lazy hop inside its routes is followed by normal `loadChildren` recursion instead).
 * Every module reached is visited once, so an import cycle terminates.
 *
 * All the tables found are returned, not just the first: Angular concatenates every
 * `RouterModule.forChild(...)` in a loaded module's import graph into that level's config, so a
 * feature that splits its routes across two routing modules genuinely has both.
 */
function findRoutesViaModuleImports(sourceFile: ts.SourceFile, filePath: string): LocatedRoutes[] {
  const found: LocatedRoutes[] = [];
  const visited = new Set<string>([filePath]);
  let frontier = [{ sourceFile, filePath }];

  for (let depth = 0; depth < MAX_MODULE_IMPORT_DEPTH && frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const current of frontier) {
      const names = new Set(ngModuleImportIdentifiers(current.sourceFile));
      if (!names.size) continue;
      for (const importedFile of importedModuleFiles(current.sourceFile, current.filePath, names)) {
        if (visited.has(importedFile)) continue;
        visited.add(importedFile);
        const importedSource = parseFileIfReadable(importedFile);
        if (!importedSource) continue;
        const located = findRoutesInFile(importedSource, importedFile);
        if (located) found.push(located);
        else next.push({ sourceFile: importedSource, filePath: importedFile });
      }
    }
    frontier = next;
  }
  return found;
}

/** Every route table a module contributes: its own, or — when it declares none — the ones its
 *  `imports:` graph registers. */
function findRoutesForModule(sourceFile: ts.SourceFile, filePath: string): LocatedRoutes[] {
  const direct = findRoutesInFile(sourceFile, filePath);
  return direct ? [direct] : findRoutesViaModuleImports(sourceFile, filePath);
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
  const located = findRoutesForModule(childSourceFile, resolvedFile);
  if (!located.length) {
    ctx.diagnostics.push(
      `loadChildren target has no routes array: ${specifier} (resolved to ${toRepoRelative(resolvedFile, ctx.cwd)}; ` +
      'no routes array, and no RouterModule.forChild(...) in it or in the modules it imports)',
    );
    return undefined;
  }

  const children: RouteNode[] = [];
  for (const entry of located) {
    // The routes may live in a file of their own (a sibling `*-routing.module.ts`), so the cycle
    // guard has to cover THAT file too, not just the module `loadChildren` named: two features
    // whose routing modules load each other would otherwise recurse forever between two files
    // neither of which is ever the `loadChildren` target.
    if (ctx.activeRouteFiles.has(entry.filePath)) {
      ctx.diagnostics.push(`loadChildren cycle detected, not expanding further: ${specifier} (from ${toRepoRelative(ctx.currentFilePath, ctx.cwd)})`);
      continue;
    }
    const childCtx: RouteParseContext = {
      ...ctx,
      currentFilePath: entry.filePath,
      activeRouteFiles: new Set([...ctx.activeRouteFiles, resolvedFile, entry.filePath]),
    };
    for (const element of entry.routesArray.elements) {
      if (ts.isObjectLiteralExpression(element)) children.push(routeObjectToPlain(element, entry.sourceFile, childCtx));
    }
  }
  return children.length ? children : undefined;
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
  // The same module handling lazy targets get: `--routes app-routing.module.ts` is the documented
  // way to point this at an NgModule app, and such a file may register its table through
  // `RouterModule.forRoot(...)` under any variable name, or hold no table at all and import the
  // module that does.
  const located = findRoutesForModule(sourceFile, fileName);
  if (!located.length) {
    // Not silence. An empty `routes[]` from a file that simply wasn't the routes file is the one
    // output a consumer cannot tell from an app with no routes, and the fix (point `--routes`
    // elsewhere) is only findable if the run says what it looked for.
    diagnostics.push(
      `no routes array found in ${toRepoRelative(fileName, cwd)} (looked for a \`routes\` array, a ` +
      'default-exported array, and RouterModule.forRoot/forChild(...) in it and in the modules it imports)',
    );
    return { routes: [], diagnostics };
  }

  const routes: RouteNode[] = [];
  for (const entry of located) {
    const ctx: RouteParseContext = {
      currentFilePath: entry.filePath,
      cwd,
      lookup,
      activeRouteFiles: new Set([fileName, entry.filePath]),
      diagnostics,
    };
    for (const element of entry.routesArray.elements) {
      if (ts.isObjectLiteralExpression(element)) routes.push(routeObjectToPlain(element, entry.sourceFile, ctx));
    }
  }
  return { routes, diagnostics };
}

/** Read and parse `config.routesFile`'s `routes` array, resolving `loadComponent`'s modern
 *  default-export form, eager `component:` targets, and `loadChildren` recursion against
 *  `lookup` (built from the already-collected `components[]` — see `buildComponentLookup`). */
export function collectRoutes(config: AngularExtractConfig, lookup: ComponentLookup): RouteParseResult {
  const text = readFileSync(config.routesFile, 'utf8');
  return collectRoutesFromSource(text, config.routesFile, lookup, config.cwd);
}
