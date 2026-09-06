# ui-manifest

Extract a structured, diffable JSON manifest — routes, components, and (optionally) their full
template/JSX element tree, including conditional-rendering logic — directly from an app's source.
Angular and React today, one shared output schema across both.

**Why**: a live crawl or an accessibility-tree snapshot only ever sees whichever single branch of
your UI happens to be rendered at capture time. Parsing the source instead captures **every**
branch a template or component can produce — every `@if`/`@for`/`@switch` case, every `*ngIf`,
every React ternary/`&&`/`.map()` — so you can tell exactly what changed in your UI's structure
between two points in time, including logic that never happened to render during either capture.

Nothing you run this against ever leaves your own environment. This tool reads your source and
writes JSON to a file or stdout — that's it. What you do with the output (commit it, diff it in CI,
feed it to your own tooling) is entirely up to you.

## Packages

| Package | What it does |
|---|---|
| [`@ui-manifest-json/core`](packages/core) | The shared `UiManifest` JSON schema (as TypeScript types) and the framework-agnostic dependency-graph resolver both extractors build on. You won't usually install this directly — the extractors depend on it. |
| [`@ui-manifest-json/angular`](packages/angular) | Extracts from an Angular app's `@Component` classes and `Routes` array. |
| [`@ui-manifest-json/react`](packages/react) | Extracts from a React app's function/class components and route configuration (`react-router-dom` JSX or object-config style). |
| [`@ui-manifest-json/cli`](packages/cli) | One `ui-manifest` command that detects whichever extractor(s) you have installed. |

Install only what you need — a React-only repo never needs to pull in `@angular/compiler`, and
vice versa.

## Quick start

```bash
npm install --save-dev @ui-manifest-json/angular
# or: npm install --save-dev @ui-manifest-json/react

npx ui-manifest-angular --with-dom --out ui-manifest.json
# or: npx ui-manifest-react --with-dom --out ui-manifest.json
```

With `@ui-manifest-json/cli` installed alongside one or both extractors, use the single `ui-manifest`
command instead — it detects which extractor(s) are present and dispatches automatically.

### Tracking UI changes over time

Run it once when you record a baseline, commit the output. From then on, in CI on every merge (or
on a schedule), regenerate it and diff against the committed version:

```bash
npx ui-manifest-angular --with-dom --out ui-manifest.json
git diff --exit-code ui-manifest.json  # fails the build if the UI's structure changed
```

Because the manifest is deterministic (sorted output, no timestamps baked into the diffable
fields), a diff only ever shows real structural changes — added/removed routes, components, inputs,
outputs, or template branches — not noise.

Two blocks are deliberately *not* diffable and should be stripped before comparing: `generatedAt`
and `provenance` (which commit produced this, which extractor version, which CI run) change on every
run. `jq 'del(.generatedAt, .provenance)'` leaves the part that only changes when the UI does.

### Knowing which build a manifest describes

```bash
npx ui-manifest-angular --out ui-manifest.json
```

Every manifest records the commit it was generated from, the remote it came from, whether the tree
was dirty, and which extractor version and analysis passes produced it — so a manifest can be
matched against a deployed build rather than only against another manifest. Outside a git tree
those fields are simply absent: the manifest is unpinned, which is a fact about it rather than a
failure.

It also records **how the app is served** — `<base href>` / React Router `basename`, and whether
routing is path- or hash-based — because a route path is not a URL until those are applied. An app
served under `/portal/` renders `/portal/dashboard`, and anything matching route paths against real
URLs without knowing that matches nothing at all. Both are detected from the source where possible;
pass `--base-href` / `--router-mode` when they are set at deploy time instead:

```bash
npx ui-manifest-angular --base-href /portal --router-mode hash --out ui-manifest.json
```

Scanning only part of an app? Pass `--coverage partial` so a consumer does not read the routes you
did not look at as routes you deleted.

### The dependency graph

Pass `--dependency-graph` (requires `--with-dom`) to additionally resolve, for every route, the
complete nested tree of every component it renders — not just that route's own top-level template,
but every descendant component's template spliced in too, recursively:

```bash
npx ui-manifest-angular --with-dom --dependency-graph --out ui-manifest.json
```

See [`docs/schema.md`](docs/schema.md) for the full output shape.

## Documentation

- [`docs/schema.md`](docs/schema.md) — the full `UiManifest` JSON schema, field by field.
- [`docs/react-extraction-limits.md`](docs/react-extraction-limits.md) — what the React extractor
  can and can't detect, and why (JSX conditional rendering is arbitrary JavaScript, not a
  first-class template grammar the way Angular's is — read this before trusting a "heuristic" node).
- [`docs/migration-from-script.md`](docs/migration-from-script.md) — for anyone migrating from the
  original single-file prototype script this project was extracted from.

## Development

```bash
npm install
npm run build       # tsc -b across all packages, in dependency order
npm test             # vitest, all packages
npm run typecheck
```

This is an npm workspaces monorepo (`packages/*`) with no bundler — plain TypeScript compiled via
`tsc -b` project references, shipped as real Node ESM.

## Origin

Built by [BrainRidge](https://github.com/BrainRidge) — generated with [Claude Code](https://claude.com/claude-code).
We're releasing it as-is, claim no exclusive credit, and you're welcome to use, fork, and modify it
as freely as the license allows.

## License

MIT — see [LICENSE](LICENSE).
