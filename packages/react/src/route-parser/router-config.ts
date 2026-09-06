import ts from 'typescript';
import type { RouteNode } from '@ui-manifest-json/core';
import { getCalleeName } from '../ts-utils.js';
import { PATHLESS_ROUTE_PATH, resolveComponentIdentifier, resolveElementComponent } from './shared.js';
import { routeElementToRouteNode } from './jsx-routes.js';

const ROUTER_FACTORY_NAMES = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter']);
const NAV_BLOCKING_HOOKS = ['usePrompt', 'useBlocker'];

function collectHookCalls(node: ts.Node, hookNames: string[]): string[] {
  const found: string[] = [];
  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n)) {
      const name = getCalleeName(n.expression);
      if (name && hookNames.includes(name)) found.push(name);
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/**
 * Best-effort nav-blocking detection for a route's target component, identified only by the JSX
 * tag name used in `element={<X/>}`. Looks ONLY within the current (router-setup) file for:
 *   - `const X = withNavigationPrompt(...)` HOC-wrapping (mirrors `react-router-navigation-prompt`'s
 *     real `withNavigationPrompt(Component)` shape), recorded as the wrapping identifier's name.
 *   - a same-file `const X = (...) => {...}` / `function X(...) {...}` whose body calls
 *     `usePrompt(message, when)` or `useBlocker(...)` (that package's real hook shape).
 * A guarded component merely imported from elsewhere (the common case) is NOT detected — this is
 * explicitly best-effort text, not a resolved guard function, per the spec this package follows.
 */
function detectNavBlocking(tagName: string, sourceFile: ts.SourceFile): string[] | undefined {
  const found = new Set<string>();

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === tagName && stmt.body) {
      collectHookCalls(stmt.body, NAV_BLOCKING_HOOKS).forEach(h => found.add(h));
    }
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== tagName || !decl.initializer) continue;
      const init = decl.initializer;
      if (ts.isCallExpression(init) && getCalleeName(init.expression) === 'withNavigationPrompt') {
        found.add('withNavigationPrompt');
      }
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) {
        collectHookCalls(init.body, NAV_BLOCKING_HOOKS).forEach(h => found.add(h));
      }
    }
  }

  return found.size > 0 ? Array.from(found) : undefined;
}

function objectLiteralToRouteNode(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  currentFilePath: string,
): RouteNode | undefined {
  let path: string | undefined;
  let isIndex = false;
  let component: RouteNode['component'];
  let children: RouteNode[] | undefined;
  let canDeactivate: string[] | undefined;

  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (!key) continue;

    if (key === 'path' && ts.isStringLiteral(prop.initializer)) {
      path = prop.initializer.text;
    } else if (key === 'index' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      isIndex = true;
    } else if (key === 'element') {
      component = resolveElementComponent(prop.initializer, sourceFile, currentFilePath);
      if (component) {
        const navBlocking = detectNavBlocking(component.export, sourceFile);
        if (navBlocking) canDeactivate = navBlocking;
      }
    } else if (key === 'Component' && ts.isIdentifier(prop.initializer)) {
      // The data-router shorthand: `Component: Layout` — a direct reference, no JSX wrapper at
      // all. Real, documented react-router-dom v6.4+/v7 API (react-router's own official
      // examples use it), not a rarely-seen variant.
      const resolved = resolveComponentIdentifier(prop.initializer.text, sourceFile, currentFilePath);
      component = resolved;
      const navBlocking = detectNavBlocking(resolved.export, sourceFile);
      if (navBlocking) canDeactivate = navBlocking;
    } else if (key === 'children' && ts.isArrayLiteralExpression(prop.initializer)) {
      const nested = prop.initializer.elements
        .filter(ts.isObjectLiteralExpression)
        .map(el => objectLiteralToRouteNode(el, sourceFile, currentFilePath))
        .filter((r): r is RouteNode => !!r);
      if (nested.length > 0) children = nested;
    }
  }

  const hasContent = path !== undefined || isIndex || component !== undefined || children !== undefined;
  if (!hasContent) return undefined;

  const node: RouteNode = { path: isIndex ? PATHLESS_ROUTE_PATH : (path ?? PATHLESS_ROUTE_PATH) };
  if (component) node.component = component;
  if (children) node.children = children;
  // React's nav-blocking hooks are named, not declared as guard objects the way Angular's are;
  // there is no separate declaration site to point at, so the name is emitted without a pointer
  // rather than with an invented one.
  if (canDeactivate) {
    node.guards = { canDeactivate: canDeactivate.map(name => ({ name, kind: 'function' as const })) };
  }
  return node;
}

type JsxRouteElement = ts.JsxElement | ts.JsxSelfClosingElement;

function isJsxRouteElement(node: ts.Node): node is JsxRouteElement {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

/** `createRoutesFromElements(<Route>...</Route>)` (or a `<>...</>` fragment of sibling
 *  `<Route>`s) — react-router's own official utility for writing data-router config using JSX
 *  syntax instead of a plain object array. Returns the bare `<Route>` element(s) passed to it, or
 *  `[]` if `expr` isn't such a call at all. */
function routeElementsFromCreateRoutesFromElements(expr: ts.Expression, sourceFile: ts.SourceFile): JsxRouteElement[] {
  if (!ts.isCallExpression(expr) || getCalleeName(expr.expression) !== 'createRoutesFromElements') return [];
  const arg = expr.arguments[0];
  if (!arg) return [];
  if (ts.isJsxFragment(arg)) {
    return arg.children.filter(isJsxRouteElement);
  }
  return isJsxRouteElement(arg) ? [arg] : [];
}

/**
 * Find `createBrowserRouter(...)`/`createHashRouter(...)`/`createMemoryRouter(...)` calls,
 * anywhere in the file (not just top-level statements — the call is typically the initializer of
 * a `const router = ...` declaration), whose first argument is EITHER:
 *   - an array literal of plain route objects (the more common shape), or
 *   - a `createRoutesFromElements(<Route>...)` call (the JSX-authored data-router shape).
 * Returns the top-level `RouteNode`s from every such call found.
 */
export function parseRouterConfigRoutes(sourceFile: ts.SourceFile, currentFilePath: string): RouteNode[] {
  const roots: RouteNode[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ROUTER_FACTORY_NAMES.has(node.expression.text) && node.arguments[0]) {
      const arg = node.arguments[0];
      if (ts.isArrayLiteralExpression(arg)) {
        const routes = arg.elements
          .filter(ts.isObjectLiteralExpression)
          .map(el => objectLiteralToRouteNode(el, sourceFile, currentFilePath))
          .filter((r): r is RouteNode => !!r);
        roots.push(...routes);
        return;
      }
      const routeElements = routeElementsFromCreateRoutesFromElements(arg, sourceFile);
      if (routeElements.length > 0) {
        const routes = routeElements
          .map(el => routeElementToRouteNode(el, sourceFile, currentFilePath))
          .filter((r): r is RouteNode => !!r);
        roots.push(...routes);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  roots.forEach(r => {
    r.routingPattern = 'router-config';
  });
  return roots;
}
