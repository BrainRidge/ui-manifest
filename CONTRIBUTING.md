# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

This is an npm workspaces monorepo (`packages/*`), plain TypeScript compiled via `tsc -b` project
references — no bundler. Each package builds to real Node ESM (`dist/`).

**Gotcha**: with `"type": "module"` + `moduleResolution: "NodeNext"`, relative imports between your
own `.ts` files need an explicit `.js` extension in the source, even though the file on disk is
`.ts` — e.g. `import { foo } from './bar.js'` for a file actually named `bar.ts`. This trips
everyone up once. TypeScript's `NodeNext` resolution expects the extension the *compiled output*
will have, not the source file's real extension.

## Where things live

- `packages/core` — the shared `UiManifest` schema (as TypeScript types, source of truth) and the
  framework-agnostic dependency-graph resolver (`resolveRouteDependencyTree`). Both extractors
  depend on this; it depends on nothing.
- `packages/angular`, `packages/react` — one extractor package per framework. Each owns its own
  parsing logic but must emit exactly the shapes `@ui-manifest-json/core` defines — if you need a field
  a framework genuinely can't populate, leave it `undefined`/omit it; don't invent a mismatched
  shape to route around a schema gap. If the schema itself needs to grow, that's a `core` change,
  proposed and reviewed on its own, since both extractors and any downstream consumer depend on it
  staying consistent.
- `packages/cli` — a thin dispatcher; it should stay thin. Framework-specific logic belongs in the
  framework's own package, not here.

## Testing conventions

Most coverage should be **inline-source unit tests**: feed a small string of Angular/TS or
React/TSX source directly to the relevant parser function and assert on the structured output. This
is fast, isolated, and how the original prototype's Angular behavior was validated in the first
place. Reach for a fixture app (`packages/*/test/fixtures/`) only for integration-level smoke
coverage that genuinely needs multiple files/a directory structure (e.g. `templateUrl` resolution
relative to a component file, or route-file-plus-component-file wiring) — not as the default way to
test a single parsing rule.

## Before tagging a release

Run the extractor you changed against a real, reasonably large app you have on hand (not just the
checked-in fixtures) and skim the output for anything that looks wrong. The checked-in fixtures are
deliberately small and can't exercise everything a real app's source will throw at the parser —
they're regression coverage for known patterns, not a substitute for one real-world sanity check.
This is a manual step, not part of CI (there's no large app checked into this repo to run it
against).

## License

By contributing, you agree your contribution is licensed under this project's MIT license (see
[LICENSE](LICENSE)).
