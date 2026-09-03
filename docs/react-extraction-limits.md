# React extraction: what's real, what's a best-effort guess

`@ui-manifest/react` uses the same syntactic-parsing posture as `@ui-manifest/angular` — no
type-checker `Program`, just TypeScript's own AST over each file. But there's a fundamental
asymmetry between the two frameworks worth understanding before you trust the output:

Angular has a **first-class template grammar** — `@if`/`@for`/`@switch`/`*ngIf` are syntax the Ivy
compiler parses completely, so `@ui-manifest/angular` either understands a construct fully or fails
loudly. React has no such grammar: conditional rendering is just arbitrary JavaScript expressions
that happen to appear inside JSX. `@ui-manifest/react` can only ever pattern-match the *common
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
  a JSX-returning `render()`, one or two levels of `forwardRef`/`memo` unwrapping).
- Prop extraction from a TS type annotation or `propTypes`.

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

`react-router-dom` v6/v7 apps are detected via **static source analysis**, not `package.json`
inspection (the two patterns below are structurally indistinguishable from a dependency list
alone):

- **`router-config`**: `createBrowserRouter`/`createHashRouter`/`createMemoryRouter([...])` with an
  array-literal argument.
- **`jsx-routes`**: a `<Routes>`/`<Route>` JSX tree.

A file that imports `react-router-dom` but matches neither pattern produces a `diagnostics` entry
naming the file, not a silent empty route list — see `docs/schema.md`'s "Diagnostics" section.

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
