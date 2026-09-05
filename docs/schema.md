# The `UiManifest` schema

Every `@ui-manifest-json/*` extractor emits the same shape, defined in `@ui-manifest-json/core`
(`packages/core/src/types/`). This page is a plain-language tour; the TypeScript source is the
actual source of truth — read it if this page and the code ever disagree.

## Top level

```ts
interface UiManifest {
  schemaVersion: "2.0";
  framework: "angular" | "react";
  app: AppIdentity;                 // where the app is SERVED from — see below
  provenance: Provenance;           // which commit, which extractor — ignore when diffing
  coverage: "full" | "partial";     // does a missing route mean deleted, or not looked at?
  coverageScope?: { routes?: string[]; paths?: string[] };
  generatedAt: string;              // ISO timestamp — ignore this field when diffing two manifests
  routes: RouteNode[];
  components: ComponentNode[];
  dependencyGraph?: RouteDependencyTree[]; // only present with --dependency-graph
  diagnostics?: string[];           // soft-failure notices — see "Diagnostics, not silent gaps" below
}
```

### What to ignore when diffing

`generatedAt` and the whole `provenance` block change on every run even when the UI does not.
`jq 'del(.generatedAt, .provenance)'` leaves a document whose every remaining field changes only
when the UI's structure does — which is the promise the README makes about diffs, and the reason
volatile data lives in its own block instead of being sprinkled through `routes` and `components`.

### `app` — where the app is served from

```ts
interface AppIdentity {
  baseHref: string;                              // "/" or "/portal"
  routerMode: "path" | "hash";
  confidence: "detected" | "configured" | "default";
}
```

These two fields decide whether a route path corresponds to a URL a browser will ever show. An app
with `<base href="/portal/">` renders `/portal/dashboard`; one built with `withHashLocation()` (or
React's `<HashRouter>`) renders `/#/dashboard`. A consumer matching a manifest against real URLs and
missing either one matches **nothing, on every route, without an error** — which looks exactly like
an app that has little in it. That is why they are required rather than optional.

`confidence` says how they were established, and it is worth checking:

| value | meaning |
|---|---|
| `detected` | read out of the source — `<base href>`, an `APP_BASE_HREF` provider, `withHashLocation()`/`useHash: true`, or React's `basename` / `HashRouter` |
| `configured` | you passed `--base-href` / `--router-mode` |
| `default` | neither — the values are the conventional `"/"` and `"path"` |

A `default` is a complete answer held with less certainty, not a failure, so it is **not** a
`diagnostics` entry: most apps are served from the root and set no base href, and a diagnostic on
nearly every run would train you to ignore the field. The CLI prints a note to stderr instead.

Detection is deliberately narrow. Only conventional router-setup files are searched (Angular:
`main.ts`, `app.config.ts`, `app.module.ts`, `*.routes.ts`; React: the files that import
`react-router`), and only string literals count — `basename={BASE}` needs a type checker, which
these extractors do not load. A false positive here would be a confident wrong answer, where a miss
defaults and says so.

### `provenance` — which commit, which extractor

```ts
interface Provenance {
  repo: {
    remoteUrl?: string;
    commit?: string;       // full sha — ABSENT outside a git tree, never a branch name
    commitTime?: string;   // committer date from git, not a generation clock
    branch?: string;       // absent on a detached HEAD
    dirty?: boolean;       // true when the tree had uncommitted changes
    appRoot?: string;      // the scanned directory, relative to the repository root
  };
  generator: { name: string; version: string; buildId?: string; passes: string[] };
}
```

Every field is best-effort and absent rather than empty. A tarball with no `.git`, a shallow CI
clone, no `git` on PATH: none is an error, they mean the manifest is **unpinned**, which is a fact
about the output. The one thing never done is substituting a plausible value — a branch name where
a commit should be looks like a pin and moves.

`dirty` matters more than it looks: a commit reported for a modified tree describes *most* of what
was extracted, not all of it.

git is asked **from the scanned directory**, not the process's working directory, so
`--dir ../other-repo/src` pins the manifest to that repo rather than to this one.

`passes` is negative information: it lets you tell "this component has no DOM tree" from "the DOM
pass never ran".

### `coverage`

`"full"` claims the run covered the whole app, which is what licenses a consumer to read a route's
**absence** as deletion. `"partial"` (with `coverageScope`) claims it did not. Without this, a
consumer merging manifests over time has to guess — and guessing "not covered" keeps deleted routes
alive forever, while guessing "deleted" throws away real ones.

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

`fullPath` is the path a URL must have to reach a route: every ancestor's `path` joined with this
one, and `baseHref` applied. It is derivable from the nested tree, but computing it here means one
implementation instead of one per consumer — and it removes a specific way to get it wrong. Two
index routes under different parents are both `path: ""`, so anything keying on `path` alone
silently collides them; their `fullPath`s (`/accounts` and `/settings`) do not.

A bare `**` wildcard gets **no** `fullPath`. It matches every path and so identifies none; giving
it one would invite a consumer to treat a fallback as a screen. Its children are still resolved —
they are reachable even though the wildcard segment is not a location.


```ts
interface RouteNode {
  path: string;              // this route's own segment, as written
  fullPath?: string;         // every ancestor's path joined, with baseHref applied
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

## Angular compiler versions

`--with-dom` uses whichever `@angular/compiler` your project has (declared peer range:
`>=17.0.0`), and that AST has changed shape twice in ways this extractor now normalises:

| change | affects |
|---|---|
| `SwitchBlock.cases` → `.groups` in v22, with a new element type that groups fall-through `@case`s | every `@switch` block |
| `TmplAstContent` gained `children` after v17 | every `<ng-content>` |

Both are feature-detected on the value rather than on a version number: the compiler is an optional
peer dependency the *consumer* resolves, so its version is not something this package can know.

Older compilers legitimately reject newer template syntax — an Angular 17 parser cannot read
`@let`, for instance. Those components come back as a `diagnostics` entry and are simply absent from
`components[].dom`, which is the documented behaviour below rather than a failure. If you want every
component's tree, run with a compiler at least as new as the app's own.

## Diagnostics, not silent gaps

Whenever an extractor hits something it can't confidently represent — an unresolved routing
pattern, a template node kind with no matching schema slot, a route pointing at a component that
wasn't found — it records a plain-English `diagnostics` entry instead of either crashing or quietly
producing an empty/misleading result. An empty `routes: []` you can trust as "genuinely no routes"
always comes with **no** matching diagnostic; if there's a diagnostic about a file, treat its
contribution to the manifest as incomplete, not absent.
