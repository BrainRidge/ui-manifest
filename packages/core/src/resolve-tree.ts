import type { ComponentNode } from './types/component.js';
import type { DomNode } from './types/dom.js';
import type { ComponentBoundaryNode, CycleMarkerNode, ResolvedNode, RouteDependencyTree } from './types/dependency-graph.js';

/**
 * Given an element's tag (e.g. "app-app-flow-tab" or a JSX identifier like "UserCard") and the
 * `ComponentNode` whose OWN template is currently being walked (i.e. the file-context that tag
 * appeared in), return the `ComponentNode` it refers to, or undefined if the tag is a plain
 * element / not a known component.
 *
 * The second argument matters: as resolution descends into a spliced child's own template, tags
 * found there must be resolved against THAT child's file, not the route's root file. Angular can
 * ignore it (a selector is a global namespace across the whole app, not file-relative) — React
 * cannot: import bindings are inherently per-file, so a `matchFn` that only ever saw the route
 * root's file would silently fail to resolve anything more than one splice deep. Framework-
 * specific either way; core only calls it.
 */
export type MatchFn = (tag: string, currentComponent: ComponentNode) => ComponentNode | undefined;

/**
 * Resolve one route's dependency tree: starting from its root component's own template, replace
 * every element whose tag matches a known component (via `matchFn`) with an annotated splice of
 * that component's own (recursively resolved) template, in place.
 *
 * Cycle detection is path-scoped: a `Set` of component classNames currently on the active
 * resolution stack, pushed on entering a splice and popped on leaving. The same component
 * legitimately appears in multiple unrelated branches of a tree and must be expanded fresh each
 * time — only a component reappearing in its own ancestor chain (direct or indirect
 * self-inclusion) is a cycle, at which point a CycleMarkerNode is emitted instead of recursing.
 */
export function resolveRouteDependencyTree(
  routePath: string,
  rootComponent: ComponentNode,
  matchFn: MatchFn,
): RouteDependencyTree {
  const path: string[] = [rootComponent.className];
  const tree = (rootComponent.dom ?? []).map(node => resolveNode(node, matchFn, path, rootComponent));
  return { routePath, rootComponent: rootComponent.className, tree };
}

function resolveNode(node: DomNode, matchFn: MatchFn, path: string[], currentComponent: ComponentNode): ResolvedNode {
  switch (node.type) {
    case 'element': {
      const matched = matchFn(node.el, currentComponent);
      if (!matched) {
        // Plain element (or an unresolvable tag) — keep as-is, but still recurse into children
        // so descendant components further down get spliced. Still within currentComponent's own
        // template, so the context doesn't change.
        return {
          ...node,
          children: node.children.map(child => resolveNode(child, matchFn, path, currentComponent)),
        };
      }
      if (path.includes(matched.className)) {
        const marker: CycleMarkerNode = {
          type: 'cycle-detected',
          extraction: 'compiler',
          tag: node.el,
          componentClassName: matched.className,
          cyclePath: [...path],
        };
        return marker;
      }
      path.push(matched.className);
      // Descending into the matched component's OWN template: it becomes the new context, so
      // any tag found within it resolves against ITS file, not the caller's.
      const children = (matched.dom ?? []).map(child => resolveNode(child, matchFn, path, matched));
      path.pop();
      const boundary: ComponentBoundaryNode = {
        type: 'component-boundary',
        extraction: node.extraction,
        tag: node.el,
        componentClassName: matched.className,
        children,
      };
      return boundary;
    }
    case 'template': {
      // Still the same component's own template (an @if/@for/ternary/etc. block doesn't cross a
      // component boundary) — context is unchanged.
      const children = node.children.map(child => resolveNode(child, matchFn, path, currentComponent));
      const branches = node.branches?.map(branch => ({
        ...branch,
        children: branch.children.map(child => resolveNode(child, matchFn, path, currentComponent)),
      }));
      return { ...node, children, ...(branches ? { branches } : {}) };
    }
    case 'text':
    case 'interpolation':
      // Leaf nodes — nothing to splice into.
      return node;
  }
}
