import ts from 'typescript';
import type { RouteNode } from '@ui-manifest-json/core';
import { collectReturnedJsx, isJsxLike, unwrapParens } from '../ts-utils.js';
import { PATHLESS_ROUTE_PATH, resolveComponentIdentifier, resolveElementComponent } from './shared.js';

type JsxElementLike = ts.JsxElement | ts.JsxSelfClosingElement;

/**
 * The elements that hold a route table.
 *
 * `<Routes>` is v6/v7. `<Switch>` is v3/v4/v5's equivalent — the same "here is the route table"
 * role, with first-match-wins semantics instead of v6's ranked matching. Recognizing only
 * `<Routes>` meant every app still on react-router-dom v4/v5 — which is a large share of
 * long-lived React codebases, not a legacy curiosity — parsed to zero routes plus one "routing
 * pattern unresolved" diagnostic per file.
 */
const ROUTE_CONTAINER_TAGS = new Set(['Routes', 'Switch']);

/** The elements that are a route ENTRY inside such a container. `<Redirect>` (v3/v4/v5) names no
 *  component but does claim a location, so it belongs in the tree — see the `from`/`to` handling
 *  in `routeElementToRouteNode`. */
const ROUTE_ENTRY_TAGS = new Set(['Route', 'Redirect']);

/** Whether a JSX attribute list carries a `path="..."` string literal. */
function hasStringPathAttribute(node: JsxElementLike, sourceFile: ts.SourceFile): boolean {
  return attributesOf(node).properties.some(
    attr =>
      ts.isJsxAttribute(attr) &&
      attr.name.getText(sourceFile) === 'path' &&
      !!attr.initializer &&
      ts.isStringLiteral(attr.initializer),
  );
}

/**
 * Whether an element sitting directly inside a route table is a route entry.
 *
 * `<Route>`/`<Redirect>` by name, plus ANY element carrying a `path="..."` attribute — which is
 * how v3/v4/v5 apps declare a guarded route: `<UserOnlyRoute exact path="/settings">`,
 * `<TokenCheckRoute path="/verify">`, a thin app-specific wrapper that forwards its props to a
 * real `<Route>` (or renders a `<Redirect>` instead). This is safe rather than a guess about
 * naming: `<Switch>` renders the FIRST child whose `path` matches and reads that prop off the
 * child itself, so an element carrying `path` inside a route table is a route entry by
 * construction, whatever its tag is called.
 *
 * What the manifest does NOT model is the wrapper's gating effect — see
 * `docs/react-extraction-limits.md`. The route and its component are reported; that reaching it
 * may require a login is not, and inventing a `guards` entry from an arbitrary tag name would
 * assert semantics this pass cannot verify.
 */
function isRouteEntry(node: JsxElementLike, sourceFile: ts.SourceFile): boolean {
  return ROUTE_ENTRY_TAGS.has(tagNameOf(node, sourceFile)) || hasStringPathAttribute(node, sourceFile);
}

function tagNameOf(node: JsxElementLike, sourceFile: ts.SourceFile): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText(sourceFile);
}

function attributesOf(node: JsxElementLike): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function isElementLike(node: ts.Node): node is JsxElementLike {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

/**
 * A container's route entries: its direct `<Route>`/`<Redirect>` children, plus the ones a
 * fragment or a conditional `{...}` child wraps.
 *
 * The conditional cases (`{isAdmin && <Route path="/admin" .../>}`, `{loggedIn ? <Route .../> :
 * <Route .../>}`) are real, common shapes, and a direct-children-only scan drops those routes
 * while the file's other routes still parse — so no diagnostic fires and the omission is silent,
 * which is exactly the failure mode this codebase treats as worse than an error.
 *
 * A `{items.map(...)}`-generated route table is deliberately NOT unrolled: its `path` is an
 * expression rather than a literal, so there is nothing static to report about it. See
 * `docs/react-extraction-limits.md`.
 */
function routeEntriesIn(container: ts.JsxElement, sourceFile: ts.SourceFile): JsxElementLike[] {
  const entries: JsxElementLike[] = [];

  const fromChild = (child: ts.JsxChild): void => {
    if (isElementLike(child)) {
      if (isRouteEntry(child, sourceFile)) entries.push(child);
      return; // a non-route element is not a route table wrapper in any router version
    }
    if (ts.isJsxFragment(child)) {
      child.children.forEach(fromChild);
      return;
    }
    if (ts.isJsxExpression(child) && child.expression) fromExpr(child.expression);
  };

  const fromExpr = (expr: ts.Expression): void => {
    const u = unwrapParens(expr);
    if (isJsxLike(u)) {
      fromChild(u);
      return;
    }
    if (ts.isConditionalExpression(u)) {
      fromExpr(u.whenTrue);
      fromExpr(u.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      fromExpr(u.right);
    }
  };

  container.children.forEach(fromChild);
  return entries;
}

/**
 * Every route tree in the file, as the JSX element that roots it.
 *
 * Two shapes produce one:
 *   - a `<Routes>`/`<Switch>` container, whose entries are the roots;
 *   - a bare `<Route>` with no container above it, which is v3/v4/v5's other legal form (every
 *     `<Route>` whose path matches renders, rather than just the first) and is still
 *     unambiguously a route definition.
 *
 * A bare `<Redirect>` is deliberately not a root. Outside a route table it is ordinary render
 * logic — `if (!user) return <Redirect to="/login"/>` inside a component — and treating that as a
 * route would invent a screen the app does not have.
 */
function findRouteRoots(sourceFile: ts.SourceFile): JsxElementLike[] {
  const roots: JsxElementLike[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && ROUTE_CONTAINER_TAGS.has(tagNameOf(node, sourceFile))) {
      roots.push(...routeEntriesIn(node, sourceFile));
      return; // one route table nested directly inside another isn't a real pattern, and a
      // matched entry's own nested routes are `routeElementToRouteNode`'s job, not this walk's.
    }
    if (isElementLike(node) && tagNameOf(node, sourceFile) === 'Route') {
      roots.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return roots;
}

/** A route element's nested routes: its own direct `<Route>` children (v6/v7, and v5's nested
 *  `<Route>` form), plus the entries of a `<Switch>`/`<Routes>` it wraps — v4/v5 nest a subtree by
 *  putting a whole second route table inside the parent `<Route>`'s body. */
function nestedRouteElements(node: ts.JsxElement, sourceFile: ts.SourceFile): JsxElementLike[] {
  const direct = node.children.filter(
    (c): c is JsxElementLike => isElementLike(c) && tagNameOf(c, sourceFile) === 'Route',
  );
  const viaContainer = node.children
    .filter((c): c is ts.JsxElement => ts.isJsxElement(c) && ROUTE_CONTAINER_TAGS.has(tagNameOf(c, sourceFile)))
    .flatMap(c => routeEntriesIn(c, sourceFile));
  return [...direct, ...viaContainer];
}

function isBooleanAttributeTrue(attr: ts.JsxAttribute): boolean {
  if (!attr.initializer) return true; // boolean shorthand: `index`, `exact`
  return (
    ts.isJsxExpression(attr.initializer) &&
    !!attr.initializer.expression &&
    attr.initializer.expression.kind === ts.SyntaxKind.TrueKeyword
  );
}

/**
 * `component={X}` (v3/v4/v5): the component is named by a plain JS expression, not a JSX tag.
 *
 * No lowercase filter here, unlike `resolveElementComponent`'s — `<h2>` is a host element because
 * JSX itself says a lowercase TAG is one, but `component={notFound}` is just an identifier lookup,
 * and a lowercase-bound component is perfectly legal there. Anything that isn't a bare identifier
 * (`component={this.renderThing}`, `component={pages[key]}`) is left unresolved rather than
 * guessed at from source text.
 */
function componentFromComponentProp(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  currentFilePath: string,
): RouteNode['component'] | undefined {
  const u = unwrapParens(expr);
  if (!ts.isIdentifier(u)) return undefined;
  return resolveComponentIdentifier(u.text, sourceFile, currentFilePath);
}

/** `render={() => <X/>}` / `render={props => <X {...props}/>}` (v4/v5): the route's component is
 *  whatever JSX the render prop returns. Reuses `collectReturnedJsx`, so a block body with early
 *  guard returns resolves to the LAST JSX returned — the same "primary render output" rule
 *  component detection applies to a component's own body. */
function componentFromRenderProp(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  currentFilePath: string,
): RouteNode['component'] | undefined {
  const u = unwrapParens(expr);
  if (!ts.isArrowFunction(u) && !ts.isFunctionExpression(u)) return undefined;
  if (!u.body) return undefined;
  const returned = collectReturnedJsx(u.body);
  const last = returned[returned.length - 1];
  return last ? resolveElementComponent(last, sourceFile, currentFilePath) : undefined;
}

/**
 * The component a route element renders as its BODY rather than through a prop:
 * `<Route path="/profile"><ProfilePage /></Route>`. This is first-class react-router v5 — the
 * idiomatic form whenever the child needs props of its own — and it is also how a custom wrapper
 * route names its target (`<UserOnlyRoute path="/settings"><Settings /></UserOnlyRoute>`).
 *
 * `<Redirect to>` as the body is read as a redirect instead of a component, so
 * `<Route path="*"><Redirect to="/" /></Route>` reports what it actually does.
 *
 * Requires EXACTLY ONE element child (ignoring whitespace, and ignoring the nested `<Route>`/
 * `<Switch>` children that `nestedRouteElements` claims): with several, there is no single
 * primary to name, and picking one would assert a structure the source doesn't state. A lone
 * host-element child (`<div>...</div>`) resolves to nothing, which is correct — it is renderable
 * JSX, not a component reference.
 */
function bodyTarget(
  node: ts.JsxElement,
  sourceFile: ts.SourceFile,
  currentFilePath: string,
): { component?: RouteNode['component']; redirectTo?: string } {
  const candidates = node.children.filter(
    (c): c is JsxElementLike =>
      isElementLike(c) &&
      !ROUTE_CONTAINER_TAGS.has(tagNameOf(c, sourceFile)) &&
      tagNameOf(c, sourceFile) !== 'Route',
  );
  if (candidates.length !== 1) return {};
  const only = candidates[0]!;

  if (tagNameOf(only, sourceFile) === 'Redirect') {
    for (const attr of attributesOf(only).properties) {
      if (!ts.isJsxAttribute(attr) || attr.name.getText(sourceFile) !== 'to') continue;
      if (attr.initializer && ts.isStringLiteral(attr.initializer)) return { redirectTo: attr.initializer.text };
    }
    return {};
  }

  return { component: resolveElementComponent(only, sourceFile, currentFilePath) };
}

/** Exported for `router-config.ts`: `createBrowserRouter(createRoutesFromElements(<Route .../>))`
 *  needs to convert bare `<Route>` JSX the same way a route table's children do — the JSX shape is
 *  identical either way, only the wrapper differs. */
export function routeElementToRouteNode(node: JsxElementLike, sourceFile: ts.SourceFile, currentFilePath: string): RouteNode | undefined {
  const tag = tagNameOf(node, sourceFile);
  let path: string | undefined;
  let isIndex = false;
  let exact = false;
  let component: RouteNode['component'];
  let redirectTo: string | undefined;

  for (const attr of attributesOf(node).properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.getText(sourceFile);
    const init = attr.initializer;
    const jsxExpr = init && ts.isJsxExpression(init) ? init.expression : undefined;

    // `from` is `<Redirect>`'s own spelling of `path` (v3/v4/v5).
    if ((name === 'path' || (name === 'from' && tag === 'Redirect')) && init && ts.isStringLiteral(init)) {
      path = init.text; // preserves catch-alls like "*" literally
    } else if (name === 'index') {
      isIndex = isBooleanAttributeTrue(attr);
    } else if (name === 'exact') {
      exact = isBooleanAttributeTrue(attr);
    } else if (name === 'to' && tag === 'Redirect' && init && ts.isStringLiteral(init)) {
      redirectTo = init.text;
    } else if (name === 'element' && jsxExpr) {
      component = resolveElementComponent(jsxExpr, sourceFile, currentFilePath);
    } else if (name === 'component' && jsxExpr) {
      component = componentFromComponentProp(jsxExpr, sourceFile, currentFilePath);
    } else if (name === 'render' && jsxExpr) {
      component = componentFromRenderProp(jsxExpr, sourceFile, currentFilePath);
    }
  }

  // Props first, body second: a prop is the explicit statement of the route's target, and no real
  // route sets both. Only when none of `element`/`component`/`render` named anything does the
  // element's own body get read (v5's `<Route path="/x"><X/></Route>`, and how a custom wrapper
  // route names its target).
  if (ts.isJsxElement(node) && component === undefined && redirectTo === undefined) {
    const body = bodyTarget(node, sourceFile, currentFilePath);
    component = body.component;
    redirectTo = body.redirectTo;
  }

  let children: RouteNode[] | undefined;
  if (ts.isJsxElement(node)) {
    const nested = nestedRouteElements(node, sourceFile)
      .map(c => routeElementToRouteNode(c, sourceFile, currentFilePath))
      .filter((r): r is RouteNode => !!r);
    if (nested.length > 0) children = nested;
  }

  const hasContent =
    path !== undefined || isIndex || component !== undefined || redirectTo !== undefined || children !== undefined;
  if (!hasContent) return undefined;

  const routeNode: RouteNode = { path: isIndex ? PATHLESS_ROUTE_PATH : (path ?? PATHLESS_ROUTE_PATH) };
  if (component) routeNode.component = component;
  // A `<Redirect to>` with no `from` is v4/v5's catch-all fallback: last in a `<Switch>`, matching
  // whatever the entries above it did not. `path` stays `''` because `path` reports the source's
  // own segment and there isn't one — synthesising a `"*"` would put text in the manifest that the
  // app never wrote. `redirectTo` being set is what marks it.
  if (redirectTo !== undefined) routeNode.redirectTo = redirectTo;
  // v4/v5's `exact` is precisely Angular's `pathMatch: 'full'` — the whole remaining URL must
  // equal this path, not merely start with it. Emitted only when the attribute is actually
  // present: prefix matching is the default in both frameworks, and Angular's parser likewise
  // omits the field rather than spelling out the default. v6/v7 `<Route>`s have no `exact`
  // attribute to read, so their output is untouched.
  if (exact) routeNode.pathMatch = 'full';
  if (children) routeNode.children = children;
  return routeNode;
}

/** Walk every route tree in the file into `RouteNode`s: `<Routes>` (v6/v7) and `<Switch>`
 *  (v3/v4/v5) tables alike, nested `<Route>` -> `children`, `index` routes and `path="*"`
 *  catch-alls preserved literally. */
export function parseJsxRoutes(sourceFile: ts.SourceFile, currentFilePath: string): RouteNode[] {
  const roots = findRouteRoots(sourceFile)
    .map(el => routeElementToRouteNode(el, sourceFile, currentFilePath))
    .filter((r): r is RouteNode => !!r);
  roots.forEach(r => {
    // Still `jsx-routes` for a `<Switch>` table, not a new pattern name: the value distinguishes
    // "routes declared as JSX elements" from "routes declared as a config object array"
    // (`router-config`), and that distinction is identical in v4/v5 and v6/v7. The router version
    // is a property of the app's dependencies, not of the detection strategy.
    r.routingPattern = 'jsx-routes';
  });
  return roots;
}
