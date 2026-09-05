# @ui-manifest-json/cli

One `ui-manifest` command that detects whichever extractor(s) you have installed and dispatches to
them.

```bash
npm install --save-dev @ui-manifest-json/cli @ui-manifest-json/angular
# or with @ui-manifest-json/react — or both

npx ui-manifest --with-dom --out ui-manifest.json
```

**This package does no extraction itself.** It is a thin dispatcher: it resolves
[`@ui-manifest-json/angular`][ng] and [`@ui-manifest-json/react`][react], and forwards your
arguments to whichever is present. Install only what you need — a React-only repo never pulls in
`@angular/compiler`, and vice versa.

You don't need this package at all if you only use one extractor; `npx ui-manifest-angular` and
`npx ui-manifest-react` are the same commands without the indirection. It exists so a shared CI
script can call one command without knowing which framework a given repo uses.

Every other flag is forwarded untouched to the extractor — see its README for the full list.

## Choosing, when there's a choice

| Installed | Behaviour |
|---|---|
| one extractor | dispatches to it |
| both | **errors**, and asks for `--framework <angular\|react>` |
| neither | errors, naming what to install |

It never guesses between two installed extractors, and never produces an empty manifest in place of
an error — a repo with both is a real situation (a migration, a monorepo), and picking one silently
would emit a manifest describing half the app.

```bash
npx ui-manifest --framework react --with-dom --out ui-manifest.json
```

## Documentation

- [The full schema][schema], field by field
- [`@ui-manifest-json/angular`][ng] / [`@ui-manifest-json/react`][react] — the per-extractor flags

## License

MIT — see [LICENSE](./LICENSE).

[ng]: https://www.npmjs.com/package/@ui-manifest-json/angular
[react]: https://www.npmjs.com/package/@ui-manifest-json/react
[schema]: https://github.com/BrainRidge/ui-manifest/blob/main/docs/schema.md
