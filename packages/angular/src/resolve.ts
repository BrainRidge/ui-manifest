import type { ComponentNode, MatchFn, RouteDependencyTree, RouteNode } from '@ui-manifest/core';
import { resolveRouteDependencyTree } from '@ui-manifest/core';

export interface DependencyGraphResult {
  dependencyGraph: RouteDependencyTree[];
  diagnostics: string[];
}

/**
 * Build every routed component's resolved dependency tree (`RouteDependencyTree`), splicing each
 * descendant component's own template in place wherever its selector tag appears — delegating the
 * actual splicing/cycle-detection walk to `@ui-manifest/core`'s `resolveRouteDependencyTree`; this
 * module only supplies the Angular-specific `matchFn`.
 *
 * Selector matching (v1 limitation, documented not a bug): only plain tag-name selectors are
 * matched (`app-foo`, or each comma-separated tag in `app-foo, app-bar`). Attribute selectors
 * (`[appFoo]`) are skipped when building the selector map, so a component that is only ever
 * applied as an attribute directive is never spliced in.
 */
export function buildDependencyGraph(routes: RouteNode[], components: ComponentNode[]): DependencyGraphResult {
  const diagnostics: string[] = [];

  const byClassName = new Map<string, ComponentNode>();
  for (const component of components) byClassName.set(component.className, component);

  // Built once, up front — never re-scanned per matchFn() call.
  const bySelectorTag = new Map<string, ComponentNode>();
  for (const component of components) {
    if (!component.selector) continue;
    for (const rawTag of component.selector.split(',')) {
      const tag = rawTag.trim();
      if (!tag || tag.startsWith('[')) continue; // attribute selectors: not matched in v1
      bySelectorTag.set(tag, component);
    }
  }
  const matchFn: MatchFn = tag => bySelectorTag.get(tag);

  const dependencyGraph: RouteDependencyTree[] = [];
  const walk = (route: RouteNode) => {
    if (route.component) {
      const root = byClassName.get(route.component.export);
      if (root) {
        dependencyGraph.push(resolveRouteDependencyTree(route.path, root, matchFn));
      } else {
        diagnostics.push(
          `dependency graph: no component found for route "${route.path}" (export "${route.component.export}")`,
        );
      }
    }
    route.children?.forEach(walk);
  };
  routes.forEach(walk);

  return { dependencyGraph, diagnostics };
}
