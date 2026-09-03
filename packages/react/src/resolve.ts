import ts from 'typescript';
import path from 'node:path';
import type { ComponentNode, MatchFn } from '@ui-manifest/core';
import { findImportBinding } from './ts-utils.js';

export interface IndexableComponent {
  node: ComponentNode;
  isDefaultExport: boolean;
}

export interface ResolveContext {
  /** Every scanned source file, keyed by its repo-relative (posix-style) path — including files
   *  with zero detected components, since a pure barrel `index.ts` (no components of its own) is
   *  still needed for one-level re-export chasing. */
  files: Map<string, ts.SourceFile>;
  /** Every detected component, keyed by `${filePath}::${exportName}` — see `buildComponentIndex`. */
  componentIndex: Map<string, ComponentNode>;
  /** Every detected component, keyed by `${filePath}::${className}` — for resolving a tag used in
   *  the SAME file it's declared in, where the JSX always references the local declaration name
   *  regardless of whether that component happens to be the file's default export. See
   *  `buildComponentIndex`. */
  sameFileIndex: Map<string, ComponentNode>;
}

function indexKey(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

/**
 * Build the two lookups `resolveJsxTagToComponent` matches against:
 *  - `componentIndex`, for resolving an IMPORTED tag: keyed by the component's file and its
 *    EXPORTED name — named exports keyed by their real name (`className`); default exports keyed
 *    under the literal name "default" regardless of what identifier the function/class happens to
 *    be bound to internally, so `import Foo from './Foo'` resolves correctly even when
 *    `./Foo.tsx` internally calls the component something else entirely.
 *  - `sameFileIndex`, for resolving a tag used in the SAME file it's declared in (no import to
 *    look up at all): keyed by the component's file and its DECLARED name (`className`) — this is
 *    always what a same-file JSX usage actually references, whether or not that declaration is
 *    also the file's default export.
 */
export function buildComponentIndex(
  entries: IndexableComponent[],
): { componentIndex: Map<string, ComponentNode>; sameFileIndex: Map<string, ComponentNode> } {
  const componentIndex = new Map<string, ComponentNode>();
  const sameFileIndex = new Map<string, ComponentNode>();
  for (const { node, isDefaultExport } of entries) {
    componentIndex.set(indexKey(node.filePath, isDefaultExport ? 'default' : node.className), node);
    sameFileIndex.set(indexKey(node.filePath, node.className), node);
  }
  return { componentIndex, sameFileIndex };
}

const RESOLVABLE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

/** Resolve a relative import specifier to a known file path, trying the specifier as-is, each of
 *  `.tsx`/`.ts`/`.jsx`/`.js` appended, and each of those under an `index.*` inside the specifier
 *  treated as a directory. Bare specifiers (npm packages, tsconfig path aliases) are out of scope
 *  — this is syntactic resolution only, no module-resolution host. */
function resolveRelativeModule(fromFile: string, spec: string, knownFiles: ReadonlySet<string>): string | undefined {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined;
  const dir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const candidates = [
    base,
    ...RESOLVABLE_EXTENSIONS.map(ext => base + ext),
    ...RESOLVABLE_EXTENSIONS.map(ext => path.posix.join(base, `index${ext}`)),
  ];
  return candidates.find(c => knownFiles.has(c));
}

interface BarrelChase {
  filePath: string;
  exportName: string;
}

/** One level of `index.ts`/`index.tsx` re-export chasing: `export { X } from './mod'` (and its
 *  `export { X as Y }` renamed form, resolved back to the original name), or `export * from
 *  './mod'` (assumed — without deeper verification — to carry the name through unchanged). Does
 *  NOT recurse into a further barrel reached this way; that's a documented v1 limitation. */
function chaseBarrel(filePath: string, exportName: string, ctx: ResolveContext): BarrelChase | undefined {
  if (!/index\.(tsx|ts|jsx|js)$/.test(filePath)) return undefined;
  const sourceFile = ctx.files.get(filePath);
  if (!sourceFile) return undefined;

  const knownFiles = new Set(ctx.files.keys());
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const targetSpecifier = stmt.moduleSpecifier.text;

    if (!stmt.exportClause) {
      // export * from './mod'
      const targetFile = resolveRelativeModule(filePath, targetSpecifier, knownFiles);
      if (targetFile) return { filePath: targetFile, exportName };
      continue;
    }
    if (ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text !== exportName) continue;
        const originalName = (el.propertyName ?? el.name).text;
        const targetFile = resolveRelativeModule(filePath, targetSpecifier, knownFiles);
        if (targetFile) return { filePath: targetFile, exportName: originalName };
      }
    }
  }
  return undefined;
}

/**
 * Resolve a JSX tag used somewhere in `currentFile`'s own JSX (e.g. `<UserCard/>`) to the
 * `ComponentNode` it refers to:
 *   0. First, check whether `tag` is simply declared in `currentFile` itself (the route root and
 *      a route's top-level component are very commonly defined in the same file as the JSX that
 *      references them — e.g. `function App() {...}` used as `<App/>` further down the very same
 *      file). If so, resolve it directly via `sameFileIndex` — no import to chase at all.
 *   1. Otherwise, find the import declaration in `currentFile` binding that tag's local name.
 *   2. Resolve the module specifier to a real scanned file (extension + `index.*` resolution).
 *   3. If that file is an `index.ts`/`index.tsx` barrel re-exporting the name from elsewhere,
 *      chase ONE level further.
 *   4. Look the resulting (file, exportName) pair up in the component index.
 *
 * Returns undefined for: no same-file declaration AND no matching import in this file, a bare/
 * unresolvable specifier, or a resolved (file, name) with no detected component.
 */
export function resolveJsxTagToComponent(tag: string, currentFile: string, ctx: ResolveContext): ComponentNode | undefined {
  const sameFile = ctx.sameFileIndex.get(indexKey(currentFile, tag));
  if (sameFile) return sameFile;

  const sourceFile = ctx.files.get(currentFile);
  if (!sourceFile) return undefined;

  const binding = findImportBinding(sourceFile, tag);
  if (!binding) return undefined;

  const knownFiles = new Set(ctx.files.keys());
  let resolvedFile = resolveRelativeModule(currentFile, binding.moduleSpecifier, knownFiles);
  if (!resolvedFile) return undefined;
  let exportName = binding.exportName;

  const chased = chaseBarrel(resolvedFile, exportName, ctx);
  if (chased) {
    resolvedFile = chased.filePath;
    exportName = chased.exportName;
  }

  return ctx.componentIndex.get(indexKey(resolvedFile, exportName));
}

/**
 * The `MatchFn` `resolveRouteDependencyTree` needs. Unlike a single fixed file, this reads the
 * CURRENT component's own `filePath` on every call — required for correctness past one level of
 * splicing: a tag found inside some spliced-in child's template must resolve against that
 * child's own import declarations, not the route root's. `resolveRouteDependencyTree` (in
 * `@ui-manifest/core`) passes the right "current" component through on every call already; this
 * function just has to actually use it instead of closing over one fixed file.
 */
export function createMatchFn(ctx: ResolveContext): MatchFn {
  return (tag, currentComponent) => resolveJsxTagToComponent(tag, currentComponent.filePath, ctx);
}
