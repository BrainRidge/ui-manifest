# Migrating from the original `gen_ui_manifest.mjs` script

`@ui-manifest/angular` is a direct port of a 419-line prototype script that some teams may already
be running as `node scripts/gen_ui_manifest.mjs [--out <path>] [--with-dom]`. If that's you, here's
exactly what changed.

## CLI flags

| Old | New | Notes |
|---|---|---|
| *(hardcoded to `src/app`)* | `--dir <path>` | Default `"src/app"`, resolved relative to your current working directory. |
| *(hardcoded to `app.routes.ts` inside `src/app`)* | `--routes <path>` | Default `"app.routes.ts"`, resolved **relative to `--dir`** — same relationship the original script always had. |
| `--with-dom` | `--with-dom` | Unchanged. |
| *(none)* | `--dependency-graph` | New — see below. Requires `--with-dom` to also be set; the CLI exits with a clear error if you pass it alone. |
| `--out <path>` | `--out <path>` | Unchanged. Omit (or pass `-`) to print to stdout, same as before. |

If you were invoking the script with no flags from your Angular app's repo root, the new CLI's
defaults (`--dir src/app`, `--routes app.routes.ts`) reproduce that exact behavior — no flags to add
for the common case.

## Output shape

The top level now wraps the old `{routes, components}` in a small envelope:

```json
{
  "schemaVersion": "1.0",
  "framework": "angular",
  "generatedAt": "2026-09-03T11:59:08.123Z",
  "routes": [ ... ],
  "components": [ ... ]
}
```

`generatedAt` changes on every run even with zero UI changes — exclude it before diffing two
manifests, or diff with a tool that ignores it.

Field renames inside `components[]` (the schema is now shared with `@ui-manifest/react`, which
forced a few names to generalize):

| Old field | New field |
|---|---|
| `file` | `filePath` |
| `class` | `className` |
| *(inputs/outputs' own)* `source: "decorator"\|"signal"` | `kind: "decorator"\|"signal"` |
| `template: {url: "..."}` \| `{inline: true}` \| `null` | `templateUrl?: string` and `inlineTemplate?: boolean` as two separate optional fields |

`routes[]`'s shape is unchanged — `path`/`redirectTo`/`pathMatch`/`component`/`children`, and
`guards: {canActivate?, canDeactivate?}` already matched this shape in the original script.

Every `DomNode` (`--with-dom` output) now carries a `type` discriminator (`"element"` /
`"text"` / `"interpolation"` / `"template"`) it didn't have before, and control-flow constructs
(`*ngIf`/`*ngFor`/`@if`/`@for`/`@switch`/`@defer`) are normalized into one shared
`{structural, condition?, branches?, children}` shape instead of five differently-keyed forms
(`if`/`for`/`switch`/`defer`/`structural`) — see `docs/schema.md` for the exact fields. If you had
code parsing the old script's raw JSON, it needs updating; if you were only ever diffing the JSON
textually (the script's original intended use), a regenerated manifest still diffs the same way.

## What's new beyond a straight port

- **`--dependency-graph`**: for every route, its root component's full descendant-component tree,
  spliced together — see `docs/schema.md`'s "The dependency graph" section.
- **`@angular/compiler` is now a lazily-loaded, optional peer dependency** rather than a hard
  top-level import — base extraction (routes/components/inputs/outputs, no `--with-dom`) works even
  if `@angular/compiler` isn't installed at all.
- **A couple of real bugs in the original script were fixed during the port**: `@switch` case
  labels were reading the wrong AST node and always came out blank; `*ngFor`'s iterable expression
  is now read from the correct desugared attribute (`ngForOf`, not `ngFor` itself). If you were
  relying on the old (broken) output for either of these, expect it to look different now — better,
  but different.
