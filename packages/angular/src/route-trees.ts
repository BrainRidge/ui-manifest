/**
 * `routeTrees[]` — which components actually render when a browser stands on a route.
 *
 * A consumer keying elements by page needs this and cannot derive it. The dependency graph is
 * rooted at each **route's** component, so it describes everything *below* the router outlet
 * and nothing above it — and the shell above the outlet is where an app puts its navigation,
 * its header and its sign-out button. On the reference app that is the entire `Logout` control:
 * declared in `NavigationComponent`, rendered on every authenticated screen, and attributed by
 * the manifest to no screen at all. Anything asking "where is the Logout button on the
 * dashboard" got "the dashboard does not have one", which is worse than an absent answer
 * because it is a confident wrong one.
 *
 * **References, never DOM.** v1 shipped a second copy of `components[].dom` under this name and
 * the two disagreed. A tree here is a list of component *names* plus how each one was reached;
 * the elements stay in `components[]`, resolved once.
 */
import type { ComponentNode, DomNode, RouteNode, SourcePointer } from '@ui-manifest-json/core';

/** One component that renders under a route, and how it got there. */
export interface RouteTreeNode {
  component: string;
  /** Where the tag that pulls it in is written. */
  via?: SourcePointer;
  /** True when the tag sits under a structural branch — a shell rendered only when signed in,
   *  for instance, which is exactly how the reference app gates its navigation. */
  conditional: boolean;
  repeated: boolean;
  children: RouteTreeNode[];
}

export interface RouteTree {
  routePath: string;
  rootComponent: string;
  nodes: RouteTreeNode[];
}

/** The element tag Angular renders a matched route into. */
const ROUTER_OUTLET = 'router-outlet';

function* walkElements(nodes: DomNode[] | undefined): Generator<{ node: DomNode; conditional: boolean; repeated: boolean }> {
  const walk = function* (list: DomNode[] | undefined, conditional: boolean, repeated: boolean): Generator<{ node: DomNode; conditional: boolean; repeated: boolean }> {
    for (const node of list ?? []) {
      if (node.type === 'template') {
        const isFor = node.structural === '@for' || node.structural === '*ngFor';
        yield* walk(node.children, true, repeated || isFor);
        // `branches[0]` IS `children` for an @if/@switch — walking both visits it twice.
        for (const branch of (node.branches ?? []).slice(1)) {
          yield* walk(branch.children, true, repeated || isFor);
        }
        continue;
      }
      if (node.type !== 'element') continue;
      yield { node, conditional, repeated };
      yield* walk(node.children, conditional, repeated);
    }
  };
  yield* walk(nodes, false, false);
}

/**
 * Components whose template contains a `<router-outlet>`: the shell a route renders *into*.
 *
 * Detected from the template rather than assumed to be `AppComponent`, because the name is a
 * convention and the outlet is the actual mechanism — a layout component two levels down that
 * hosts a nested outlet composes with its child routes exactly the same way.
 */
export function shellComponents(components: ComponentNode[]): ComponentNode[] {
  return components.filter(component => {
    for (const { node } of walkElements(component.dom)) {
      if (node.type === 'element' && node.el.toLowerCase() === ROUTER_OUTLET) return true;
    }
    return false;
  });
}

/** Every component a template pulls in by tag, recursively, cycles cut at an ancestor. */
function composedUnder(
  component: ComponentNode,
  bySelectorTag: Map<string, ComponentNode>,
  ancestors: string[],
): RouteTreeNode[] {
  const out: RouteTreeNode[] = [];
  for (const { node, conditional, repeated } of walkElements(component.dom)) {
    if (node.type !== 'element') continue;
    const child = bySelectorTag.get(node.el);
    if (!child) continue;
    if (ancestors.includes(child.className)) continue;   // a cycle back to an ancestor
    out.push({
      component: child.className,
      ...(node.source ? { via: node.source } : {}),
      conditional,
      repeated,
      children: composedUnder(child, bySelectorTag, [...ancestors, child.className]),
    });
  }
  return out;
}

/**
 * One tree per route: the shell chain above the outlet, then whatever the route's own component
 * composes.
 *
 * The shell is prepended rather than merged, so a consumer folding these in order gets the
 * screen the way it renders — shell first, route content second.
 */
export function buildRouteTrees(routes: RouteNode[], components: ComponentNode[]): RouteTree[] {
  const byClassName = new Map(components.map(c => [c.className, c]));
  const bySelectorTag = new Map<string, ComponentNode>();
  for (const component of components) {
    if (!component.selector) continue;
    for (const rawTag of component.selector.split(',')) {
      const tag = rawTag.trim();
      if (!tag || tag.startsWith('[')) continue;   // attribute selectors: not matched
      bySelectorTag.set(tag, component);
    }
  }

  // The shell itself, plus everything it composes. A shell that hosts the outlet is not
  // itself "under" any route, so it is named as a node rather than as the root.
  const shells = shellComponents(components);
  const shellNodes: RouteTreeNode[] = shells.map(shell => ({
    component: shell.className,
    conditional: false,
    repeated: false,
    children: composedUnder(shell, bySelectorTag, [shell.className]),
  }));

  const trees: RouteTree[] = [];
  const walk = (route: RouteNode) => {
    const target = route.component?.export;
    const root = target ? byClassName.get(target) : undefined;
    if (root) {
      trees.push({
        routePath: route.fullPath ?? route.path,
        rootComponent: root.className,
        nodes: [
          ...shellNodes,
          ...composedUnder(root, bySelectorTag, [root.className, ...shells.map(s => s.className)]),
        ],
      });
    }
    route.children?.forEach(walk);
  };
  routes.forEach(walk);
  return trees;
}
