import type { ComponentNode } from './component.js';
import type { RouteNode } from './route.js';
import type { RouteDependencyTree } from './dependency-graph.js';
import type { AppIdentity, Coverage, CoverageScope, Provenance } from './provenance.js';

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
   *  as `generatedAt`. */
  provenance: Provenance;
  /** Whether a missing route means "deleted" or "not looked at". See {@link Coverage}. */
  coverage: Coverage;
  coverageScope?: CoverageScope;
  /** ISO timestamp of generation. Not diff-relevant on its own — consumers diffing two
   *  manifests should ignore this field, since it changes on every run even with no UI change. */
  generatedAt: string;
  routes: RouteNode[];
  components: ComponentNode[];
  /** Present only when the extractor was run with dependency-graph resolution enabled. */
  dependencyGraph?: RouteDependencyTree[];
  /** Soft-failure notices, e.g. "routing pattern unresolved for src/App.tsx". Never used in
   *  place of throwing for a hard failure — this is for partial, recoverable extraction gaps. */
  diagnostics?: string[];
}
