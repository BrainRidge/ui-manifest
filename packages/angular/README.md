# @ui-manifest-json/angular

Extract a structured, diffable JSON manifest — routes, components, and optionally their full
template element tree — from an Angular app's source.

```bash
npm install --save-dev @ui-manifest-json/angular
npx ui-manifest-angular --with-dom --out ui-manifest.json
```

**Why source-derived**: a live crawl or an accessibility snapshot only ever sees whichever branch of
your UI happened to be rendered at capture time. Parsing the source captures **every** branch a
template can produce — every `@if`/`@for`/`@switch` case, every `*ngIf` — including logic that never
rendered during either capture.

Nothing leaves your environment. This reads your source and writes JSON.

## How it works

A syntactic pass over each component source file (via the `typescript` package's AST) and over your
`Routes` array. **No type-checker `Program`, no `tsc` project load** — so it never needs a tsconfig,
installed `node_modules`, or a compiling project, and runs fine against partially-broken code.
The trade is that anything not visible syntactically is left out rather than guessed at.

`--with-dom` additionally parses every template with `@angular/compiler`'s real Ivy
`parseTemplate()` — the same parser Angular's own compiler uses. It's an optional peer dependency,
imported lazily only when you pass the flag.

## Options

| Flag | Default | |
|---|---|---|
| `--dir <path>` | `src/app` | Directory to scan |
| `--routes <file>` | `app.routes.ts` | Routes file, relative to `--dir` |
| `--with-dom` | off | Also emit each component's template tree |
| `--dependency-graph` | off | Per route, splice every descendant component's template in recursively (requires `--with-dom`) |
| `--base-href <path>` | detected | Override the detected `<base href>` |
| `--router-mode <mode>` | detected | `path` or `hash` |
| `--coverage <kind>` | `full` | `full` or `partial` — whether a missing route means deleted |
| `--out <path>` | stdout | Write to a file |

`--base-href` and `--router-mode` are detected from `index.html`, an `APP_BASE_HREF` provider, and
`withHashLocation()` / `useHash: true`. Pass them when they're set at deploy time instead — an app
served under `/portal/` renders `/portal/dashboard`, and a consumer matching route paths against
real URLs without knowing that matches nothing at all.

## Tracking UI changes over time

```bash
npx ui-manifest-angular --with-dom --out ui-manifest.json
git diff --exit-code ui-manifest.json   # fails the build if the UI's structure changed
```

Output is deterministic, so a diff only shows real structural changes. Strip the two volatile
blocks first — `jq 'del(.generatedAt, .provenance)'` — since those change on every run.

## Angular compiler versions

Peer range is `>=17.0.0`, and `--with-dom` uses whichever `@angular/compiler` your project has.
The AST has changed shape twice (`SwitchBlock.cases` → `.groups` in v22; `TmplAstContent` gained
`children` after v17) and both are normalised. Older compilers legitimately can't parse newer
template syntax — those components come back as a `diagnostics` entry rather than a crash.

`typescript` is capped at `<6.0.0` deliberately: TypeScript 7 is the native compiler rewrite and its
root export is no longer the classic AST API this package uses.

## Documentation

- [The full schema][schema], field by field
- [Schema v2 roadmap][roadmap] — what's landing next and why

## License

MIT — see [LICENSE](./LICENSE).

[schema]: https://github.com/BrainRidge/ui-manifest/blob/main/docs/schema.md
[roadmap]: https://github.com/BrainRidge/ui-manifest/blob/main/docs/schema-v2-roadmap.md
