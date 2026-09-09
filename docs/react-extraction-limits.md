# React extraction: what's real, what's a best-effort guess

`@ui-manifest-json/react` uses the same syntactic-parsing posture as `@ui-manifest-json/angular` — no
type-checker `Program`, just TypeScript's own AST over each file. But there's a fundamental
asymmetry between the two frameworks worth understanding before you trust the output:

Angular has a **first-class template grammar** — `@if`/`@for`/`@switch`/`*ngIf` are syntax the Ivy
compiler parses completely, so `@ui-manifest-json/angular` either understands a construct fully or fails
loudly. React has no such grammar: conditional rendering is just arbitrary JavaScript expressions
that happen to appear inside JSX. `@ui-manifest-json/react` can only ever pattern-match the *common
shapes* people actually write, not guarantee it caught every way a component might conditionally
render something.

This is why every node in a `DomNode` tree carries `extraction: "compiler" | "heuristic"` — see
`docs/schema.md`. Here's exactly what falls into each bucket for React.

## `extraction: "compiler"` — trustworthy, not a guess

- Every plain JSX element, its static attributes, bound props/events (anything in a JSX
  `{expression}`), and text content. TypeScript's JSX parser understands real JSX syntax
  completely; capturing an expression's raw source text exactly isn't a guess even when we don't
  evaluate what it means.
- Component detection itself (function components with a JSX-returning body, class components with
  a JSX-returning `render()`, one or two levels of `forwardRef`/`memo` unwrapping). File extension
  is not part of it: `.js`, `.jsx` and `.tsx` all parse JSX identically, so a Babel-compiled app
  that writes every component in a plain `.js` file is read the same as a TypeScript one. Only
  `.ts` is excluded, because JSX cannot appear there (`<T>x` is a type assertion).
- Which export is a module's *default*, including through an HOC call chain —
  `export default connect(mapState)(Page)`, `withRouter(Page)`, `compose(a, b)(Page)`. Resolved
  only when the exported expression references exactly one component declared in that file;
  ambiguity is left unresolved rather than guessed. This is what makes
  `import Page from './Page'` resolve in the dependency graph.
- Prop extraction from a TS type annotation or `propTypes`.

**A class component extending another component class is NOT detected** — `class Favorites extends
Profile`, overriding one render helper and inheriting `render()`. Detection requires a base of
`Component`/`PureComponent`, and resolving an arbitrary base class across files needs a type
checker this pass deliberately does not load. Such a component is absent from `components[]`, and a
route pointing at it reports `dependency graph: no component found for route …` rather than failing
silently.

## `extraction: "heuristic"` — best-effort pattern matching, three shapes only

Only these three JSX-child patterns are recognized as control flow. Anything else stays a plain
`InterpolationNode` capturing the raw expression source — never silently dropped, just not
classified as branching logic:

- **Ternary**: `cond ? <A/> : <B/>` (or `: null`) where at least one arm is JSX.
- **`&&` short-circuit**: `cond && <A/>` where the right-hand side is JSX.
- **`.map()` returning JSX**: `items.map(item => <Row .../>)`. The callback's JSX is captured
  **once**, as a template shape — not unrolled per array element, matching how Angular's `@for`
  captures its body once too.

**What this deliberately does NOT catch**: conditional rendering hidden behind a helper function
(`{renderBody()}`), a `switch` statement assigned to a variable before being rendered, a custom
hook that returns different JSX per call, `React.createElement(...)` used directly instead of JSX
syntax, or any conditional logic that doesn't syntactically appear as one of the three shapes above
inside a JSX `{...}` expression. These aren't bugs to fix later so much as an inherent limit of
static analysis over arbitrary imperative code — there is no complete list of "every way JS can
conditionally produce a value." If your codebase leans heavily on one of these patterns, expect
gaps in that area specifically.

## Routing: two patterns detected, one explicitly not

`react-router-dom` apps are detected via **static source analysis**, not `package.json` inspection
(the two patterns below are structurally indistinguishable from a dependency list alone):

- **`router-config`**: `createBrowserRouter`/`createHashRouter`/`createMemoryRouter([...])` with an
  array-literal argument (v6.4+/v7).
- **`jsx-routes`**: a JSX route table — `<Routes>` on v6/v7, `<Switch>` on v3/v4/v5, or bare
  `<Route>`s with no container at all (also legal on v3/v4/v5).

Both major eras of the JSX form are read, including how each names a route's target:

| written as | versions | read |
| --- | --- | --- |
| `element={<X/>}` | v6/v7 | yes |
| `component={X}` | v3/v4/v5 | yes |
| `render={() => <X/>}` | v4/v5 | yes, via the last JSX the render prop returns |
| `<Route path="/x"><X/></Route>` | v5 | yes, when the body has exactly one element child |
| `<Redirect from="/a" to="/b"/>` | v3/v4/v5 | yes, as `redirectTo` |
| `children={({match}) => <X/>}` | v4/v5 | **no** — use `render` |

`exact` (v4/v5) is reported as `pathMatch: "full"`, which is the same thing Angular's `pathMatch`
means. Its absence is prefix matching, the default in both frameworks, and is left unstated rather
than spelled out.

`routingPattern` stays `"jsx-routes"` for a `<Switch>` table: the value distinguishes "routes
declared as JSX elements" from "routes declared as a config object array", and that distinction is
the same in v4/v5 and v6/v7. The router version is a property of the app's dependencies, not of the
detection strategy.

### What routing does NOT capture

- **A custom route wrapper's gating effect.** An element carrying a `path` attribute inside a route
  table is read as a route whatever its tag (`<UserOnlyRoute exact path="/settings">`,
  `<TokenCheckRoute path="/verify">`) — `<Switch>` reads `path` off the child itself, so this is
  structural, not a naming guess. But the wrapper's *effect* is not modelled: the route and its
  component are reported, and that reaching it may require a login is **not**. No `guards` entry is
  invented from an arbitrary tag name. Read a route as "this screen exists at this path", never as
  "anyone can reach this path".
- **A route table built by `.map()`.** `<Switch>{routes.map(r => <Route path={r.path} .../>)}</Switch>`
  is not unrolled — `path` is an expression, not a literal, so there is nothing static to report.
  Conditionally rendered entries (`{isAdmin && <Route .../>}`, and both ternary arms) *are* read.
- **How separate route tables compose.** On v4/v5 a parent route's component renders its own
  `<Switch>` in another file, so a manifest of such an app has several top-level route trees rather
  than one nested tree, and two routes can share a `fullPath` (`/` mounting a shell whose own table
  also has a `/`). Only tables nested in the same JSX (`<Route path="/app"><Switch>...</Switch></Route>`)
  become `children`.
- **`<Navigate to>` as a v6 route element** is reported as a component named `Navigate`, not as
  `redirectTo`. Its v4/v5 counterpart `<Redirect>` *is* read as a redirect.

A file that imports a route-**defining** name (`Route`, `Routes`, `Switch`, `createBrowserRouter`,
`createHashRouter`, `createMemoryRouter`, `createRoutesFromElements`) but matches neither pattern
produces a `diagnostics` entry naming the file, not a silent empty route list — see
`docs/schema.md`'s "Diagnostics" section. A file that imports react-router only to *navigate*
(`Link`, `NavLink`, `withRouter`, `useNavigate`, `Redirect` used as render logic) defines no route
table, so it contributes neither routes nor a diagnostic.

**Nav-blocking detection (`guards.canDeactivate`) only looks within the same file as the router
setup.** `usePrompt`/`useBlocker`/`withNavigationPrompt` usage on a route component that's merely
*imported* from elsewhere isn't detected — this is a best-effort text capture of the wrapping
identifier's name, explicitly not a resolved guard function the way Angular's is.

**Next.js file-based routing (`app/`/`pages/` directory conventions) is not implemented.** It's a
deliberate, documented gap — `routingPattern: "file-based"` is reserved on the type so it can be
added later without a schema change, but no directory-walk route inference happens today. A
Next.js app's routes will not appear in the output at all via this path.

## Dependency-graph resolution (`--dependency-graph`)

- **Import resolution is relative-specifier only.** Bare imports (npm packages) and tsconfig path
  aliases (`@/components/...`) aren't resolved — a component imported that way won't be spliced
  in, though it's still detected and listed in `components[]` on its own.
- **Barrel re-export chasing goes exactly one level.** `export { Button } from './Button'` inside an
  `index.ts` resolves; a barrel that re-exports from *another* barrel does not chase further.
- **A component used in the same file it's defined in, without going through an import, is not
  resolved.** This mirrors the Angular extractor's own posture (identification is declaration-
  driven, not usage-driven) rather than being a React-specific gap.

None of these limitations are silent: an unresolved tag is simply left as a plain `ElementNode`
(not spliced into a `ComponentBoundaryNode`) rather than causing an error, and the component itself
still appears correctly in `components[]` either way.

A route whose own component cannot be resolved is a bigger loss — its whole tree is missing from
`dependencyGraph` — so it records `dependency graph: no component found for route "<path>" (export
"<X>" from "<module>")`, the same wording the Angular extractor uses. Two shapes are excluded from
that entry because they are unresolvable by design and reporting them would be pure noise: a bare
module specifier (`element={<Outlet/>}` from `react-router-dom`, or a path alias) and a
namespace-qualified tag (`element={<React.Suspense>…}`).
