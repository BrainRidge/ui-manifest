export interface RouteGuards {
  canActivate?: string[];
  canDeactivate?: string[];
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
  };
  redirectTo?: string;
  pathMatch?: string;
  guards?: RouteGuards;
  children?: RouteNode[];
  /** React only, set at the tree root: which detection strategy produced this tree. */
  routingPattern?: ReactRoutingPattern;
}
