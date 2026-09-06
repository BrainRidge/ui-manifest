import type { SourcePointer } from './source.js';

/**
 * One guard on a route.
 *
 * v2 emitted a bare name. A name cannot be opened, so "what gates this route?" was answerable
 * only as far as "something called authGuard" — and the follow-up, which is the one that matters
 * when a test cannot reach a screen, needed a repository search to answer.
 */
export interface RouteGuard {
  name: string;
  kind: 'function' | 'class';
  source?: SourcePointer;
}

export interface RouteGuards {
  canActivate?: RouteGuard[];
  canActivateChild?: RouteGuard[];
  canDeactivate?: RouteGuard[];
  canMatch?: RouteGuard[];
}

export type ReactRoutingPattern = 'jsx-routes' | 'router-config' | 'file-based';

export interface RouteNode {
  /** This route's own segment, exactly as written in the source. */
  path: string;
  /**
   * The full path a URL must have to reach this route: every ancestor's `path` joined with this
   * one, `baseHref` applied, and leading/trailing slashes normalised.
   *
   * Derivable by a consumer from the tree — but doing it here means one implementation instead of
   * one per consumer, and it removes a specific way to get it wrong: two `''` children under
   * different parents are the same `path` and different `fullPath`s, so a consumer keying on
   * `path` silently collides them.
   *
   * Absent for a route that cannot BE a URL — a bare `**` wildcard matches every path and so
   * identifies none, and giving it a `fullPath` would invite a consumer to treat it as a screen.
   */
  fullPath?: string;
  /** The resolved lazy-loaded target, e.g. Angular's loadComponent or a React <Route element>. */
  component?: {
    module: string;
    export: string;
    source?: SourcePointer;
  };
  loadComponent?: {
    module: string;
    export: string;
    source?: SourcePointer;
  };
  redirectTo?: string;
  pathMatch?: string;
  guards?: RouteGuards;
  /** Query parameters this route reads. */
  queryParamKeys?: string[];
  /** Where the route object literal is written. */
  source?: SourcePointer;
  children?: RouteNode[];
  /** React only, set at the tree root: which detection strategy produced this tree. */
  routingPattern?: ReactRoutingPattern;
}
