import type { ComponentNode } from './component.js';
import type { RouteNode } from './route.js';
import type { RouteDependencyTree } from './dependency-graph.js';

export const SCHEMA_VERSION = '1.0';

export type Framework = 'angular' | 'react';

export interface UiManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  framework: Framework;
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
