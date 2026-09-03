import type { BaseNode, DomNode, ElementNode, InterpolationNode, TemplateNode, TextNode } from './dom.js';

/**
 * An annotated splice point: the subtree of a descendant component, spliced in where its
 * custom-element tag appeared in the parent's template, wrapped with provenance so consumers
 * (including a future diff engine) can tell a component boundary was crossed without
 * re-running resolution. Deliberately NOT a silently-flattened inline — see docs/schema.md.
 *
 * `children` is `ResolvedNode[]`, not `DomNode[]`: the spliced-in subtree is itself recursively
 * resolved, so it can contain further component-boundary splices and cycle markers, not just
 * raw template nodes.
 */
export interface ComponentBoundaryNode extends BaseNode {
  type: 'component-boundary';
  /** The tag that was matched, e.g. "app-app-flow-tab" or a React component identifier. */
  tag: string;
  componentClassName: string;
  children: ResolvedNode[];
}

/**
 * Emitted instead of recursing when a component reappears in its own ancestor chain
 * (direct or indirect self-inclusion). Never a global "already seen anywhere" cutoff —
 * the same component legitimately appears in multiple unrelated branches and must be
 * expanded each time; only a cycle back to an ancestor is cut off.
 */
export interface CycleMarkerNode extends BaseNode {
  type: 'cycle-detected';
  tag: string;
  componentClassName: string;
  /** The ancestor className chain (root-first) that produced the cycle. */
  cyclePath: string[];
}

/**
 * The resolved-tree counterpart to DomNode: every DomNode variant, but element/template nodes
 * are parameterized so their `children` can also hold component-boundary splices and cycle
 * markers, plus the two new leaf kinds themselves.
 */
export type ResolvedNode =
  | ElementNode<ResolvedNode>
  | TextNode
  | InterpolationNode
  | TemplateNode<ResolvedNode>
  | ComponentBoundaryNode
  | CycleMarkerNode;

export interface RouteDependencyTree {
  /** Matches RouteNode.path of the route this tree was resolved for. */
  routePath: string;
  rootComponent: string;
  tree: ResolvedNode[];
}

// Re-exported so consumers of dependency-graph.ts don't also need a separate dom.ts import
// just to reference the base DomNode shape a matchFn receives.
export type { DomNode };
