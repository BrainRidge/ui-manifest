import ts from 'typescript';
import type { RouteNode } from '@ui-manifest/core';
import { PATHLESS_ROUTE_PATH, resolveElementComponent } from './shared.js';

type JsxElementLike = ts.JsxElement | ts.JsxSelfClosingElement;

function tagNameOf(node: JsxElementLike, sourceFile: ts.SourceFile): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText(sourceFile);
}

function attributesOf(node: JsxElementLike): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function childElementsNamed(node: ts.JsxElement, name: string, sourceFile: ts.SourceFile): JsxElementLike[] {
  return node.children.filter(
    (c): c is JsxElementLike => (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && tagNameOf(c, sourceFile) === name,
  );
}

/** Find every `<Routes>...</Routes>` element in the file, regardless of nesting depth (it is
 *  typically wrapped in `<BrowserRouter>`/`<HashRouter>`, and either way could appear anywhere a
 *  component's JSX is walked). */
function findRoutesElements(sourceFile: ts.SourceFile): ts.JsxElement[] {
  const found: ts.JsxElement[] = [];
  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) && tagNameOf(node, sourceFile) === 'Routes') {
      found.push(node);
      return; // a <Routes> nested inside another <Routes> isn't a real pattern — stop here.
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function isIndexAttributeTrue(attr: ts.JsxAttribute): boolean {
  if (!attr.initializer) return true; // boolean shorthand: `index`
  return (
    ts.isJsxExpression(attr.initializer) &&
    !!attr.initializer.expression &&
    attr.initializer.expression.kind === ts.SyntaxKind.TrueKeyword
  );
}

/** Exported for `router-config.ts`: `createBrowserRouter(createRoutesFromElements(<Route .../>))`
 *  needs to convert bare `<Route>` JSX the same way a `<Routes>` tree's children do — the JSX
 *  shape is identical either way, only the wrapper differs. */
export function routeElementToRouteNode(node: JsxElementLike, sourceFile: ts.SourceFile, currentFilePath: string): RouteNode | undefined {
  let path: string | undefined;
  let isIndex = false;
  let component: RouteNode['component'];

  for (const attr of attributesOf(node).properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.getText(sourceFile);
    if (name === 'path' && attr.initializer && ts.isStringLiteral(attr.initializer)) {
      path = attr.initializer.text; // preserves catch-alls like "*" literally
    } else if (name === 'index') {
      isIndex = isIndexAttributeTrue(attr);
    } else if (name === 'element' && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
      component = resolveElementComponent(attr.initializer.expression, sourceFile, currentFilePath);
    }
  }

  let children: RouteNode[] | undefined;
  if (ts.isJsxElement(node)) {
    const nested = childElementsNamed(node, 'Route', sourceFile)
      .map(c => routeElementToRouteNode(c, sourceFile, currentFilePath))
      .filter((r): r is RouteNode => !!r);
    if (nested.length > 0) children = nested;
  }

  const hasContent = path !== undefined || isIndex || component !== undefined || children !== undefined;
  if (!hasContent) return undefined;

  const routeNode: RouteNode = { path: isIndex ? PATHLESS_ROUTE_PATH : (path ?? PATHLESS_ROUTE_PATH) };
  if (component) routeNode.component = component;
  if (children) routeNode.children = children;
  return routeNode;
}

/** Walk every `<Routes>` tree found in the file into `RouteNode`s: nested `<Route>` -> `children`,
 *  `index` routes and `path="*"` catch-alls preserved literally. */
export function parseJsxRoutes(sourceFile: ts.SourceFile, currentFilePath: string): RouteNode[] {
  const roots: RouteNode[] = [];
  for (const routesEl of findRoutesElements(sourceFile)) {
    const topLevel = childElementsNamed(routesEl, 'Route', sourceFile)
      .map(c => routeElementToRouteNode(c, sourceFile, currentFilePath))
      .filter((r): r is RouteNode => !!r);
    roots.push(...topLevel);
  }
  roots.forEach(r => {
    r.routingPattern = 'jsx-routes';
  });
  return roots;
}
