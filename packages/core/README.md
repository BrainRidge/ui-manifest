# @ui-manifest-json/core

The shared `UiManifest` schema — as TypeScript types — plus the framework-agnostic helpers every
extractor builds on.

**You don't usually install this directly.** [`@ui-manifest-json/angular`][ng] and
[`@ui-manifest-json/react`][react] depend on it. Install it on its own when you're *consuming*
manifests and want the types, or writing an extractor for another framework.

```bash
npm install @ui-manifest-json/core
```

## What's in it

```ts
import type { UiManifest, RouteNode, ComponentNode, DomNode } from '@ui-manifest-json/core';

const manifest: UiManifest = JSON.parse(await readFile('ui-manifest.json', 'utf8'));
```

The full shape is documented field by field in [docs/schema.md][schema]. The types are the source of
truth; that page is the tour.

Three runtime helpers ship alongside the types:

| Export | What it does |
|---|---|
| `resolveRouteDependencyTree` | Splices each component's template into its parent's where the child's tag appears, recursively, with component-boundary and cycle markers. Framework-agnostic: you supply a `matchFn` that decides which tag maps to which component. |
| `resolveFullPaths` | Walks a nested route tree and annotates each node with the full path a URL must have to reach it, `baseHref` applied. |
| `collectRepoProvenance` / `generatorProvenance` | Reads the commit, remote, branch, dirty state and app root out of the git working tree, and the build id out of CI. Best-effort: outside a git tree every field is simply absent, which means the manifest is unpinned rather than that anything failed. |

## Schema version

`SCHEMA_VERSION` is `"2.0"`. A manifest carries it as `schemaVersion`, and it is the one field to
check before trusting the rest — v2 made `app.baseHref` and `app.routerMode` required, and without
those a route path cannot be matched against a real URL at all.

## License

MIT — see [LICENSE](./LICENSE).

[ng]: https://www.npmjs.com/package/@ui-manifest-json/angular
[react]: https://www.npmjs.com/package/@ui-manifest-json/react
[schema]: https://github.com/BrainRidge/ui-manifest/blob/main/docs/schema.md
