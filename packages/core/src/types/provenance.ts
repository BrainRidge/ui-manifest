/**
 * Where a manifest came from: which app, which commit, which extractor run.
 *
 * v1 could answer "what does this UI contain" but not "which build is this" — so two manifests
 * could only ever be compared against each other, never against a deployed thing. Everything here
 * exists to make a manifest self-locating.
 *
 * **This whole block is non-diffable**, in the same sense `generatedAt` already is: `commit` and
 * `buildId` change on every run even when the UI does not. `jq 'del(.generatedAt, .provenance)'`
 * restores a document whose every remaining field changes only when the UI's structure does. That
 * is why it is a segregated top-level block rather than fields sprinkled through `routes` and
 * `components`.
 */

/** How the app's router turns a route path into a URL. */
export type RouterMode = 'path' | 'hash';

/**
 * Where the app is served from, which is what decides whether a route path matches a real URL.
 *
 * Both fields are REQUIRED, and that is deliberate. Omitting either does not produce an error in
 * any consumer — it produces a silent, total miss. An app served under `/portal/` renders
 * `/portal/dashboard`; a manifest that says `dashboard` matches nothing, on every route, and looks
 * exactly like a manifest for an app that simply has little in it. `useHash: true` fails the same
 * way. A field whose absence is indistinguishable from a wrong answer has to be required.
 */
export interface AppIdentity {
  /**
   * The app's base path, from Angular's `<base href>` / `APP_BASE_HREF`, or React Router's
   * `basename`. `"/"` when the app is served from the root — which is the common case, and is a
   * real answer rather than a default standing in for "unknown".
   */
  baseHref: string;
  /** `"hash"` for `useHash: true` / `HashRouter`, which puts the entire route after a `#`. */
  routerMode: RouterMode;
  /** How `baseHref`/`routerMode` were established. `"detected"` means read out of the source;
   *  `"configured"` means the caller supplied them; `"default"` means neither, and the values are
   *  the conventional ones — which a consumer should treat as a weaker claim. */
  confidence: 'detected' | 'configured' | 'default';
}

/** The commit the source was in when the manifest was generated. */
export interface RepoProvenance {
  /** `origin`'s URL, as git reports it. Absent outside a git working tree. */
  remoteUrl?: string;
  /** Full commit sha. Absent outside a git working tree, and deliberately NOT defaulted to a
   *  branch name: a branch moves, so a manifest pinned to one is not pinned at all. Its absence
   *  marks the output as unpinned, which is information a consumer can act on. */
  commit?: string;
  /** Committer timestamp, ISO 8601. From git, never from a clock: it is what orders two manifests
   *  that arrive out of sequence, and a generation timestamp would order them by when they were
   *  uploaded rather than by which describes newer code. */
  commitTime?: string;
  branch?: string;
  /** True when the working tree had uncommitted changes — so `commit` describes *most* of what was
   *  extracted, not all of it. Silently reporting a commit for a dirty tree is how a manifest comes
   *  to describe code that was never committed anywhere. */
  dirty?: boolean;
  /** The scanned directory, relative to the repository root. Every `filePath` in the manifest is
   *  relative to this, so a consumer can reconstruct a repo-relative path without guessing. */
  appRoot?: string;
}

/** Which extractor produced this, and what it actually ran. */
export interface GeneratorProvenance {
  name: string;
  version: string;
  /** The CI run that produced it, when one did (`GITHUB_RUN_ID` and friends). */
  buildId?: string;
  /**
   * Analysis passes that ran, e.g. `["routes", "components", "dom", "dependency-graph"]`.
   *
   * The point is negative information: a consumer must be able to tell "this component has no DOM
   * tree" from "the DOM pass never ran". Without it, every optional field is ambiguous between
   * "absent" and "not looked for", and a consumer either re-runs unnecessarily or trusts a gap.
   */
  passes: string[];
}

export interface Provenance {
  repo: RepoProvenance;
  generator: GeneratorProvenance;
}

/**
 * Whether this manifest describes the whole app or a named part of it.
 *
 * Load-bearing for anything that merges manifests over time. Given only a manifest that lacks a
 * route, a consumer cannot tell whether the route was DELETED or merely not covered by this run —
 * and guessing "not covered" means a deleted route lives forever, while guessing "deleted" throws
 * away a real one. `"full"` is a claim that absence means deletion; `"partial"` is a claim that it
 * does not, and `coverageScope` says what was actually looked at.
 */
export type Coverage = 'full' | 'partial';

export interface CoverageScope {
  routes?: string[];
  paths?: string[];
}
