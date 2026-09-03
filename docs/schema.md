# The `UiManifest` schema

Every `@ui-manifest-json/*` extractor emits the same shape, defined in `@ui-manifest-json/core`
(`packages/core/src/types/`). This page is a plain-language tour; the TypeScript source is the
actual source of truth — read it if this page and the code ever disagree.

## Top level

```ts
interface UiManifest {
  schemaVersion: "1.0";
  framework: "angular" | "react";
  generatedAt: string;              // ISO timestamp — ignore this field when diffing two manifests
  routes: RouteNode[];
  components: ComponentNode[];
  dependencyGraph?: RouteDependencyTree[]; // only present with --dependency-graph
  diagnostics?: string[];           // soft-failure notices — see "Diagnostics, not silent gaps" below
}
```

## Components

```ts
interface ComponentNode {
  className: string;
  filePath: string;          // relative to the target directory you pointed the extractor at
  selector?: string;         // Angular only
  standalone?: boolean;      // Angular only
  templateUrl?: string;
  inlineTemplate?: boolean;
  styleUrls?: string[];
  inputs: PropertyBinding[]; // Angular only — always [] for React components
  outputs: PropertyBinding[];// Angular only — always [] for React components
  props?: PropDefinition[];  // React only — undefined for Angular components
  dom?: DomNode[];           // present only with --with-dom
}
```

This asymmetry is deliberate, not an oversight: Angular's `@Input()`/`@Output()` split has no
equivalent at the JSX-consumption level, so forcing a fake unification would hide real differences
rather than represent them honestly. Don't write consumer code that assumes `inputs`/`outputs` are
populated for a React component, or that `props` is populated for an Angular one.

## Routes

```ts
interface RouteNode {
  path: string;
  component?: { module: string; export: string };
  redirectTo?: string;
  pathMatch?: string;
  guards?: { canActivate?: string[]; canDeactivate?: string[] };
  children?: RouteNode[];
  routingPattern?: "jsx-routes" | "router-config" | "file-based"; // React only, set at the tree root
}
```

For React, `guards.canDeactivate` is a best-effort text capture of a nav-blocking hook/HOC name
(`usePrompt`, `useBlocker`, `withNavigationPrompt`) — unlike Angular's guard names, it is **not** a
resolved guard function reference. Treat it as a hint, not a guarantee.

## The DOM/JSX tree (`--with-dom`)

```ts
type DomNode = ElementNode | TextNode | InterpolationNode | TemplateNode;

interface BaseNode { extraction: "compiler" | "heuristic"; }
```

`extraction` is a **per-node** honesty marker, not one blended confidence score for the whole
manifest:

- `"compiler"` — produced by a real parser (Angular's Ivy `parseTemplate()`, or TypeScript's JSX
  AST) that either understands the construct completely or fails loudly. Unconditionally
  trustworthy.
- `"heuristic"` — produced by pattern-matching arbitrary code (React's ternary / `&&` / `.map()`
  control-flow detection) rather than a grammar built for the purpose. Best-effort: the underlying
  JS can always route around the pattern in a way that isn't detected. See
  `react-extraction-limits.md` for exactly which nodes this applies to.

```ts
interface ElementNode {
  type: "element";
  el: string;                    // tag name, e.g. "div" or "app-app-flow-tab" / "UserCard"
  attrs: Record<string, string>; // static attributes
  props: BoundExpr[];            // bound properties: [value], JSX {expr} props
  events: BoundExpr[];           // bound events: (click), JSX onClick={...}
  refs?: string[];               // Angular #templateRef vars
  children: DomNode[];
}

interface BoundExpr { name: string; expr: string; } // e.g. {name: "class.active", expr: "isActive"}

interface TextNode { type: "text"; value: string; }

interface InterpolationNode { type: "interpolation"; interpolation: string; }

interface TemplateNode {
  type: "template";
  structural: "*ngIf" | "*ngFor" | "@if" | "@for" | "@switch" | "@defer" | "ternary" | "&&" | ".map()";
  condition?: string;
  branches?: { label: string; condition?: string; children: DomNode[] }[];
  children: DomNode[];  // the primary/consequent branch, so every DomNode has a children array
}
```

## The dependency graph (`--dependency-graph`, requires `--with-dom`)

For each route, its root component's `dom` tree with every descendant component spliced in, in
place of its custom-element tag — recursively, so a route's tree shows every reachable component's
actual structure inlined, not just a flat per-component list stopping at component boundaries.

```ts
interface RouteDependencyTree {
  routePath: string;
  rootComponent: string;
  tree: ResolvedNode[];
}

type ResolvedNode = DomNode | ComponentBoundaryNode | CycleMarkerNode;
// (DomNode's own children recurse into ResolvedNode too, once resolution starts — see core's types)

interface ComponentBoundaryNode {
  type: "component-boundary";
  tag: string;               // the matched custom-element tag
  componentClassName: string;
  children: ResolvedNode[];  // that component's own template, recursively resolved
}

interface CycleMarkerNode {
  type: "cycle-detected";
  tag: string;
  componentClassName: string;
  cyclePath: string[];       // the ancestor className chain that produced the cycle
}
```

**Splices are annotated, not silently flattened.** A `ComponentBoundaryNode` wraps every spliced-in
subtree with `{tag, componentClassName}` provenance rather than replacing the tag with markup
indistinguishable from what was already there. This is deliberate: it lets you (or a future diff
tool) tell exactly where a component boundary was crossed without re-running resolution. Flattening
it if you ever want the unmarked version is trivial; the reverse isn't.

**Cycle detection is path-scoped**, not "seen anywhere." The same component legitimately appears in
multiple unrelated branches of a tree and is expanded fresh every time; only a component reappearing
in its own ancestor chain (direct or indirect self-inclusion) produces a `CycleMarkerNode` instead
of infinite recursion.

## Diagnostics, not silent gaps

Whenever an extractor hits something it can't confidently represent — an unresolved routing
pattern, a template node kind with no matching schema slot, a route pointing at a component that
wasn't found — it records a plain-English `diagnostics` entry instead of either crashing or quietly
producing an empty/misleading result. An empty `routes: []` you can trust as "genuinely no routes"
always comes with **no** matching diagnostic; if there's a diagnostic about a file, treat its
contribution to the manifest as incomplete, not absent.
