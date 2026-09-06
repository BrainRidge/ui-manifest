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
import type { SourcePointer } from './source.js';

export type Extraction = 'compiler' | 'heuristic';

export interface BaseNode {
  extraction: Extraction;
}

/** A bound property/event: e.g. {name: "class.active", expr: "isActive"} or {name: "click", expr: "onClick()"}. */
export interface BoundExpr {
  name: string;
  expr: string;
  /**
   * What kind of binding this is.
   *
   * `[(ngModel)]` desugars into a property AND an event, and in v2 the write-back was
   * indistinguishable from a real handler — so a consumer counting handlers got 20 where the app
   * had 7, and every two-way-bound input looked interactive twice. `twoWayWriteback` marks the
   * generated half.
   */
  kind?: 'dom' | 'output' | 'twoWay' | 'twoWayWriteback';
  /** Where the handler METHOD is declared — the `.ts` file, not the template. */
  handler?: SourcePointer;
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

  /** Where this element is written. */
  source?: SourcePointer;

  // --- token material: the raw attributes a consumer keys on -------------------------------
  // Deliberately NOT a computed token. Some of the rules that decide one are not where you would
  // look for them (an element holding a value drops its text; `<input type="submit">` is a button
  // spelled as an input), and the rule is versioned — a token baked into these bytes could not be
  // re-keyed without asking the client's CI to run again. Emit the raw material; let the consumer
  // key it.

  /** STATIC child text only, folded from `TextNode` children and trimmed. An interpolation is
   *  never text: a key built from one changes with the test data. */
  staticText?: string;
  /** True when any child was an interpolation — so "no staticText" can be told apart from
   *  "the text is dynamic". */
  hasDynamicText?: boolean;
  /** `static`: a stable handle exists. `dynamic`: a token-bearing attribute is an expression
   *  (`[attr.id]="'tx-' + tx.id"`), and `tokenTemplate` carries the literal prefix. `none`: this
   *  control has no stable handle at all — which is the most actionable thing this file says. */
  tokenStability?: 'static' | 'dynamic' | 'none';
  tokenTemplate?: string;

  // --- semantics ---------------------------------------------------------------------------
  controlType?: ControlType;
  /** The tag as WRITTEN, when it differs from what renders (`mat-select` -> a listbox). */
  sourceRepresentation?: string;
  role?: string;
  accessibleName?: string;
  required?: boolean;

  // --- DENORMALIZED ancestry: a consumer never walks the tree -------------------------------
  // This is what licenses `nodePolicy: "semantic"` to drop presentational wrappers. Nothing
  // downstream needs the ancestors, because every ancestor's condition is copied onto the
  // elements beneath it.

  /** True when any ancestor is a structural branch. */
  conditional?: boolean;
  /** Every gate between the template root and this element, outermost first. */
  conditionChain?: ConditionLink[];
  repeated?: boolean;
  repeatOver?: string;
  repeatVar?: string;
  repeatTrackBy?: string;

  /**
   * Handles the SOURCE offers for this element — audit material, never a locator to drive.
   *
   * `unique` computed within one template is a weaker claim than a live DOM's uniqueness: the
   * shell and the route component both render into one page, so a token unique in its own file
   * can still collide once composed. `uniqueScope` says which claim is being made.
   */
  selectorCandidates?: SelectorCandidate[];
}

/** One structural gate, as written in the template. */
export interface ConditionLink {
  /** `*ngIf`, `@if`, `@for`, `@switch`, `@defer`, ... */
  directive: string;
  /** The guiding expression. Free text with no grammar — treat it as data. */
  expr: string;
  /** Which branch of a multi-branch construct this element sits in (`if`, `else if`, `else`,
   *  a `@switch` case label, `empty`, `placeholder`). */
  branch?: string;
  source?: SourcePointer;
}

export interface SelectorCandidate {
  by: 'testid' | 'id' | 'name' | 'aria' | 'role' | 'placeholder' | 'text' | 'css';
  value: string;
  unique: boolean;
  uniqueScope: 'template' | 'route';
}

/** What a person can DO with this element, independent of how it is spelled. */
export type ControlType =
  | 'textbox' | 'combobox' | 'listbox' | 'checkbox' | 'radio' | 'button' | 'link'
  | 'datepicker' | 'fileinput' | 'slider' | 'grid' | 'tab' | 'other';

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
  source?: SourcePointer;
}

export type DomNode = ElementNode | TextNode | InterpolationNode | TemplateNode;
