import type { ComponentNode } from './component.js';
import type { RouteNode } from './route.js';
import type { RouteDependencyTree } from './dependency-graph.js';
import type {
  AppIdentity, Coverage, CoverageScope, GeneratorProvenance, Provenance, RepoProvenance,
} from './provenance.js';
import type { Uncapturable } from './uncapturable.js';
import type { SourcePointer } from './source.js';

/**
 * Bumped to "2.0" for the `app` block, whose two fields are REQUIRED — see `AppIdentity`. A
 * consumer needs exactly one field to test to know whether the routes it is about to read can be
 * matched against real URLs at all, and that field is this one.
 */
export const SCHEMA_VERSION = '2.0';

export type Framework = 'angular' | 'react';

export interface UiManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  framework: Framework;
  /** Where the app is served from. Required: without it every route in this file is unmatchable
   *  against a real URL, silently. See {@link AppIdentity}. */
  app: AppIdentity;
  /** Which commit, which extractor, which passes. Non-diffable — ignore it when diffing, the same
   *  as `generatedAt`.
   *
   *  Kept alongside the top-level `repo`/`generator` below rather than replaced by them: a
   *  consumer written against the first 2.0 release reads this block, and breaking it would make
   *  a field addition into a coordinated release. The two are the same objects. */
  provenance: Provenance;
  /**
   * The same `provenance.repo` / `provenance.generator`, lifted to the top level.
   *
   * Both spellings exist on purpose. Nesting keeps the non-diffable data in one block a
   * `jq 'del(.provenance)'` can drop whole; lifting is what consumers that require these fields
   * read. `repo.remoteUrl` and `repo.appRoot` are optional on the nested copy (they are absent
   * outside a git tree, which is information) and REQUIRED here — outside a git tree this pair is
   * simply not emitted, so "present but hollow" never occurs.
   */
  repo?: RepoProvenance & { remoteUrl: string; appRoot: string };
  generator?: GeneratorProvenance & { generatedAt: string };
  /** Whether a missing route means "deleted" or "not looked at". See {@link Coverage}. */
  coverage: Coverage;
  coverageScope?: CoverageScope;
  /** ISO timestamp of generation. Not diff-relevant on its own — consumers diffing two
   *  manifests should ignore this field, since it changes on every run even with no UI change. */
  generatedAt: string;
  /**
   * Whether presentational nodes were dropped.
   *
   * `"semantic"` means the tree is NOT the DOM: a wrapper carrying nothing but a class, with no
   * events, no props and no handle, is folded away and its static text folded into its parent.
   * That is a large reduction with no loss to any join, precisely because `conditionChain` is
   * denormalized onto each element — nothing downstream needs the ancestors that were dropped.
   */
  nodePolicy?: 'semantic' | 'verbatim';
  /** How many nodes `nodePolicy` removed, so a consumer knows the tree is not the DOM. */
  collapsedNodeCount?: number;
  routes: RouteNode[];
  /**
   * Wildcard routes.
   *
   * Kept out of `routes[]` because a `**` matches every URL and so identifies none: given a page
   * key it would fold every unmatched screen onto one node, which is worse than a miss.
   */
  fallbacks?: { pattern: string; redirectTo?: string; source?: SourcePointer }[];
  components: ComponentNode[];
  /**
   * Which components render under each route — the shell above the router outlet included.
   *
   * References, never DOM: the elements live in `components[]` and are resolved once. Without
   * this a consumer keying elements by page attributes the shell's navigation to no page at
   * all, and "where is the sign-out button on this screen" answers "this screen has none".
   */
  routeTrees?: {
    routePath: string;
    rootComponent: string;
    nodes: { component: string; via?: SourcePointer; conditional: boolean; repeated: boolean;
             children: unknown[] }[];
  }[];
  /** What the extractor could not statically resolve. See {@link Uncapturable}. */
  uncapturable?: Uncapturable[];
  /** Present only when the extractor was run with dependency-graph resolution enabled. */
  dependencyGraph?: RouteDependencyTree[];
  /** Soft-failure notices, e.g. "routing pattern unresolved for src/App.tsx". Never used in
   *  place of throwing for a hard failure — this is for partial, recoverable extraction gaps. */
  diagnostics?: string[];
}
