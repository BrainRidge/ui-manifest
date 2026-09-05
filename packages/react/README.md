# @ui-manifest-json/react

Extract a structured, diffable JSON manifest — routes, components, and optionally their full JSX
element tree — from a React app's source.

```bash
npm install --save-dev @ui-manifest-json/react
npx ui-manifest-react --with-dom --out ui-manifest.json
```

**Why source-derived**: a live crawl only ever sees whichever branch of your UI happened to be
rendered at capture time. Parsing the source captures **every** branch — every ternary, `&&`, and
`.map()` — including logic that never rendered during either capture.

Nothing leaves your environment. This reads your source and writes JSON.

## How it works

A syntactic pass over your `.ts`/`.tsx`/`.jsx` files via the `typescript` package's AST. **No
type-checker `Program`, no `tsc` project load** — so it needs no tsconfig, no installed
`node_modules`, and no compiling project.

Routes come from either React Router pattern, detected per file:

- `createBrowserRouter` / `createHashRouter` / `createMemoryRouter` with a route-object array
- a `<Routes>…<Route/>…</Routes>` JSX tree

Both `react-router-dom` and the base `react-router` package are recognised — v6.4+ apps
increasingly import from the latter directly.

## Read this before trusting a `heuristic` node

Every node carries `extraction: "compiler" | "heuristic"`. JSX conditional rendering is **arbitrary
JavaScript**, not a template grammar built for the purpose, so control-flow detection is
pattern-matching and is marked honestly as such — the underlying code can always route around a
pattern in a way that isn't detected. Angular's equivalent is a real parser and is marked
`compiler`.

[docs/react-extraction-limits.md][limits] is the full account of what can and can't be detected.

**Known gap**: Next.js file-based routing (`app/`/`pages/`) is not implemented. It's a documented
stub, not a silent miss.

## Options

| Flag | Default | |
|---|---|---|
| `--dir <path>` | `src` | Directory to scan |
| `--routes-glob <glob>` | all files | Narrow which files are checked for router setups |
| `--with-dom` | off | Also emit each component's JSX tree |
| `--dependency-graph` | off | Splice descendant components in recursively (implies `--with-dom`) |
| `--warn-unnamed` | off | Diagnostic per skipped anonymous default export |
| `--base-href <path>` | detected | Override the detected router `basename` |
| `--router-mode <mode>` | detected | `path` or `hash` |
| `--coverage <kind>` | `full` | `full` or `partial` — whether a missing route means deleted |
| `--out <path>` | stdout | Write to a file |

`--base-href` and `--router-mode` are detected from `basename` on your router and from
`HashRouter`/`createHashRouter`. Only string literals count — `basename={BASE}` needs a type
checker, which this package deliberately doesn't load, so it defaults and says so via
`app.confidence`.

## Tracking UI changes over time

```bash
npx ui-manifest-react --with-dom --out ui-manifest.json
git diff --exit-code ui-manifest.json   # fails the build if the UI's structure changed
```

Strip the volatile blocks before diffing: `jq 'del(.generatedAt, .provenance)'`.

## Documentation

- [The full schema][schema], field by field
- [React extraction limits][limits] — what's detectable, and why
- [Schema v2 roadmap][roadmap]

## License

MIT — see [LICENSE](./LICENSE).

[schema]: https://github.com/BrainRidge/ui-manifest/blob/main/docs/schema.md
[limits]: https://github.com/BrainRidge/ui-manifest/blob/main/docs/react-extraction-limits.md
[roadmap]: https://github.com/BrainRidge/ui-manifest/blob/main/docs/schema-v2-roadmap.md
