/**
 * The template/JSX element tree shape both extractors emit.
 *
 * `extraction` is a per-node honesty marker, not a single blended confidence score:
 * - "compiler": produced by a real parser (Angular's Ivy `parseTemplate()`, or TypeScript's
 *   JSX AST) that either understands the construct completely or fails loudly. Unconditionally
 *   trustworthy.
 * - "heuristic": produced by pattern-matching arbitrary code (React's ternary/`&&`/`.map()`
 *   control-flow detection) rather than a grammar built for the purpose. Best-effort — the
 *   underlying JS could always route around the pattern in a way that isn't detected.
 */
export type Extraction = 'compiler' | 'heuristic';

export interface BaseNode {
  extraction: Extraction;
}

/** A bound property/event: e.g. {name: "class.active", expr: "isActive"} or {name: "click", expr: "onClick()"}. */
export interface BoundExpr {
  name: string;
  expr: string;
}

/**
 * `Child` is generic so the resolved dependency-graph tree (packages/core/src/types/
 * dependency-graph.ts) can reuse this exact shape with a wider child type (one that also
 * allows ComponentBoundaryNode/CycleMarkerNode) instead of duplicating every field.
 */
export interface ElementNode<Child = DomNode> extends BaseNode {
  type: 'element';
  /** Tag name, e.g. "div" or a custom element/component tag like "app-app-flow-tab". */
  el: string;
  /** Static attributes (string-literal values only). */
  attrs: Record<string, string>;
  /** Bound properties, e.g. [value], [class.active], JSX {expr} props. */
  props: BoundExpr[];
  /** Bound events, e.g. (click), JSX onClick={...}. */
  events: BoundExpr[];
  /** Template reference variables (#ref). Angular only. */
  refs?: string[];
  children: Child[];
}

export interface TextNode extends BaseNode {
  type: 'text';
  value: string;
}

export interface InterpolationNode extends BaseNode {
  type: 'interpolation';
  /** Raw source of the interpolation, e.g. "Hello {{ name }}" or the JSX {expr} source text. */
  interpolation: string;
}

export type StructuralKind =
  | '*ngIf'
  | '*ngFor'
  | '@if'
  | '@for'
  | '@switch'
  | '@defer'
  | 'ternary'
  | '&&'
  | '.map()';

export interface TemplateBranch<Child = DomNode> {
  label: string;
  condition?: string;
  children: Child[];
}

export interface TemplateNode<Child = DomNode> extends BaseNode {
  type: 'template';
  structural: StructuralKind;
  /** The raw guiding expression: @if condition, ternary test, && LHS, .map() source array, etc. */
  condition?: string;
  /** Present for multi-branch constructs (@if/@else chains, @switch cases, ternaries). */
  branches?: TemplateBranch<Child>[];
  /** The primary/consequent branch's children, kept so every DomNode has a `children` array. */
  children: Child[];
}

export type DomNode = ElementNode | TextNode | InterpolationNode | TemplateNode;
