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
| [`@ui-manifest/core`](packages/core) | The shared `UiManifest` JSON schema (as TypeScript types) and the framework-agnostic dependency-graph resolver both extractors build on. You won't usually install this directly — the extractors depend on it. |
| [`@ui-manifest/angular`](packages/angular) | Extracts from an Angular app's `*.component.ts` files and `Routes` array. |
| [`@ui-manifest/react`](packages/react) | Extracts from a React app's function/class components and route configuration (`react-router-dom` JSX or object-config style). |
| [`@ui-manifest/cli`](packages/cli) | One `ui-manifest` command that detects whichever extractor(s) you have installed. |

Install only what you need — a React-only repo never needs to pull in `@angular/compiler`, and
vice versa.

## Quick start

```bash
npm install --save-dev @ui-manifest/angular
# or: npm install --save-dev @ui-manifest/react

npx ui-manifest-angular --with-dom --out ui-manifest.json
# or: npx ui-manifest-react --with-dom --out ui-manifest.json
```

With `@ui-manifest/cli` installed alongside one or both extractors, use the single `ui-manifest`
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
