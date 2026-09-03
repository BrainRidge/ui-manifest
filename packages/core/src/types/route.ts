export interface RouteGuards {
  canActivate?: string[];
  canDeactivate?: string[];
}

export type ReactRoutingPattern = 'jsx-routes' | 'router-config' | 'file-based';

export interface RouteNode {
  path: string;
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
