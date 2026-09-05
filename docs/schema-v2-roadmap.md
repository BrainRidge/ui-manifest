# Schema v2 roadmap

What v2 adds, in the order it has to land, and what each phase unblocks.

The through-line: v1 answers **"what does this UI contain, and how did it change?"** — which is what
a diff needs. v2 answers a second question a diff cannot: **"where in the source is this thing, and
which build am I looking at?"** A consumer that finds a UI element at runtime and wants to reach the
code that declares it currently has to grep for it. Every phase below is a step toward that being a
lookup instead.

Two constraints shape the whole plan, and neither is negotiable.

**Determinism is a feature, not an accident.** The README promises "a diff only ever shows real
structural changes". Line numbers do not survive that promise: inserting one import at the top of a
file changes every `startLine` below it, and a manifest that reports a thousand changes for one
unrelated edit is worse than one that reports none. So everything volatile in v2 lives in
**segregated top-level blocks**, never interleaved into `routes`/`components`/`dependencyGraph`.
`generatedAt` already sets that precedent; v2 keeps to it, and `jq 'del(.generatedAt, .provenance,
.sources)'` must always restore an exactly-diffable document. Phase 3 is where this is easiest to get
wrong, and it is designed around the constraint rather than despite it.

**No type-checker.** `packages/angular/src/index.ts` states the rule and the reason: this is a
syntactic pass, so it works on partially-broken code with no tsconfig, no installed `node_modules`
and no compiling project. Almost everything below is syntactically reachable. The one thing that is
not — following a click handler through a service into an HTTP call — is quarantined in Phase 6
behind its own opt-in, so the fast path never pays for it.

---

## Phase 1 — make the manifest locatable at all

**Unblocks:** any consumer joining a manifest to something observed at runtime.

| Field | Why |
|---|---|
| `app.baseHref` | An app served at `/portal/` renders URLs `/portal/dashboard`; a manifest that says `dashboard` matches none of them. **Required**, because omitting it does not fail — it *misses*, silently, on every route, and reads as "this tool didn't help much". |
| `app.routerMode` | `"path"` or `"hash"`. `useHash: true` puts the whole route after a `#` and misses just as completely. Required for the same reason. |
| `routes[].fullPath` | Parent segments joined. The tree already resolves `children` and `loadChildren`, so this is a walk, not new analysis — but doing it here means one implementation instead of one per consumer, and two `''` children under different parents stop colliding. |
| `provenance.repo` | `remoteUrl`, `commit`, `commitTime`, `branch`, `dirty`, `appRoot`. A manifest that cannot say which commit produced it can only be compared against *now*. |
| `provenance.generator` | `name`, `version`, `buildId`, and `passes[]` — which analyses ran. A consumer must be able to tell "this element has no accessible name" from "the a11y pass never ran". |
| `coverage` | `"full"` or `"partial"` (+ `coverageScope`). A consumer merging manifests needs to know whether a route's absence means *deleted* or merely *not in this run*. Without it, an incremental manifest silently resurrects deleted routes forever. |

`commit` stays **optional**: a developer generating locally has no meaningful one, and its absence is
information — it marks the output as unpinned rather than pretending otherwise.

`provenance` and `app` are new top-level blocks. `provenance` is documented non-diffable alongside
`generatedAt`; `app` is stable and diffable.

**`schemaVersion` becomes `"2.0"` here**, not later. `baseHref` and `routerMode` are *required*, and a
consumer needs one field to test to know whether it can trust the routes it is reading.

**React:** `basename` on `<BrowserRouter>`/`createBrowserRouter` is `baseHref`; `HashRouter` is
`routerMode: "hash"`. Both are syntactically visible where the router is constructed.

---

## Phase 2 — make the *elements* joinable, not just the routes

**Unblocks:** matching a single rendered control back to the template that produced it.

Phase 1 gets a consumer to the right screen. This gets it to the right element.

| Field | Why |
|---|---|
| `testid` | Whichever of `data-testid` / `data-test-id` / `data-test` / `data-qa` / `data-cy` is present, lifted to its own key. It is already in `attrs`, but every consumer then has to know the precedence order — and a consumer that checks only `data-testid` silently matches nothing in a Cypress codebase. |
| `staticText` | Static text children concatenated. The single best handle for a button that has no other one. |
| `hasDynamicText` | Whether an interpolation contributed. A key built from `{{ user.name }}` changes with the data, so a consumer must be able to tell static text from rendered text — and today it cannot without walking children itself. |
| `tokenStability` | `"static"` (every identifying attribute is a literal), `"dynamic"` (at least one is an expression, e.g. `[attr.id]="'row-' + i"` — one template node, N different runtime ids), or `"none"` (no identifying attribute at all). |
| `tokenTemplate` | For `"dynamic"`: the literal prefix, so a consumer can match `row-*` rather than give up. |
| `unkeyed[]` | Per component: the controls where `tokenStability` is `"none"`, with their structural path. |

`unkeyed[]` is the one with a payoff beyond joining. An icon button with no id, no name, no test id
and a ligature for text cannot be addressed by anything — and the list of them, with file and line
once Phase 3 lands, is a directly actionable report: *these are the controls nothing can reliably
target*. That is worth emitting even to a consumer doing no joining at all.

---

## Phase 3 — source pointers

**Unblocks:** going from "this component" to "this line", with no grep.

```ts
interface SourcePointer {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  blobOid?: string;   // git blob sha — survives a rename, and lets two manifests skip a re-read
}
```

**This is cheap, which is not obvious.** Angular's `parseTemplate()` already hands every node a
`sourceSpan` whose `ParseLocation` carries `line` and `col` outright, and TypeScript AST nodes carry
positions via `getLineAndCharacterOfPosition`. Both parsers already compute this and the extractors
discard it. Phase 3 is reading a field, not adding an analysis.

One real wrinkle: for an **inline** `template:` string the Ivy spans are relative to the template
literal, not the `.ts` file. Mapping to a file line means adding the literal's own start offset —
worth a dedicated test, because getting it wrong produces plausible line numbers that are quietly off
by however long the file's preamble is.

**Where the pointers go is the important decision.** Not inline on every node: a 600k-node manifest
with a `startLine` on each is a diff that changes on every unrelated edit, which breaks the promise
in the README. Instead, one top-level `sources` side-table keyed by a stable node key, so:

- deleting `sources` restores a byte-identical v1-shaped diffable document;
- a consumer that wants pointers pays one join;
- a consumer that only diffs never sees them.

Behind `--source-pointers`, off by default, and stated in the docs as non-diffable in the same breath
as `generatedAt`.

---

## Phase 4 — say what you could not see

**Unblocks:** telling "the manifest is stale" apart from "this element is injected at runtime".

`diagnostics: string[]` already does the right thing — the "Diagnostics, not silent gaps" section is
the correct instinct and predates all of this. Phase 4 promotes it to a structured sibling:

```ts
interface Uncapturable {
  kind: 'dynamicComponentOutlet' | 'innerHTML' | 'runtimeRoute' | 'unresolvedLazyChunk'
      | 'thirdPartyWebComponent' | 'iframe' | 'dynamicSelector' | 'templateParseError';
  source?: SourcePointer;
  detail?: string;
  affects?: string;    // the route or component whose coverage this hole affects
}
```

`diagnostics` stays, unchanged, for anything that is genuinely just a notice.

Why it matters more than it looks: a consumer comparing a manifest against a live UI finds elements
in the UI that are not in the manifest, and there are exactly two causes — the manifest is out of
date, or the element is injected by something static analysis cannot see. Without this list those two
are indistinguishable, and every such finding is undiagnosable. With it, the answer falls out: if
that component's holes name an `innerHTML` binding, it is the second; if not, it is the first.

Also in this phase, because it removes the last reason to walk ancestors:

| Field | Why |
|---|---|
| `conditional`, `conditionChain` | Denormalized onto the element. `TemplateNode.branches` already carries this; the walk to collect it is the same for every consumer. |
| `repeated`, `repeatOver`, `repeatVar` | v1 puts the `*ngFor` iterable in `condition` and **loses the loop variable**. Both are needed: the iterable explains why duplicates exist, the variable is how the row's identifying expression reads. |

Denormalizing also makes node collapsing safe — see the note at the end.

---

## Phase 5 — semantics

**Unblocks:** treating a control as what it *is* rather than what tag it happens to be.

| Field | Why | Cost |
|---|---|---|
| `controlType` | `mat-select` / `p-dropdown` / `ng-select` → `"combobox"`. A consumer seeing a rendered `<div role="combobox">` has no way to know it is a Material select and must not be driven as a native one. | Low — a lookup table |
| `sourceRepresentation` | The original tag, kept beside the normalized type | Free |
| `role`, `accessibleName` | Computed as far as static analysis honestly allows: `aria-label`, then `<label for>` in the same template, then static text. Never a guess at a dynamic name. | Moderate; partial by nature, so `passes[]` must say whether it ran |
| `logicalControlPath` | Full path through nested `FormGroup`s — `application.applicant.email`. A bare `formControlName` is ambiguous the moment two groups reuse a field name. | Moderate, and syntactic: the FormGroup is nearly always in the same component file |
| `validators`, `required` | From the template attribute and the reactive validators | Moderate |
| `options[]` | Static `<option>` children | Low |
| `sourceHash`, `templateHash` | Per component. Lets an incremental run skip components whose bytes did not move. | Trivial |

`options[]` and `required` are worth more than their size suggests: they are two things a runtime
observer genuinely cannot get right — a live crawl sees whichever options were loaded, and cannot
tell a field that is required from one that merely happened to be filled.

---

## Phase 6 — the expensive one, quarantined

**Unblocks:** connecting a UI action to the network call it causes.

| Field | Why |
|---|---|
| `dependencyGraph` edges | A real `import` / `provider` / `inject` graph. Note the existing `dependencyGraph` is a *composition* tree (which components render inside which) and is genuinely useful — this is a different thing, and should be a differently-named field rather than a redefinition of a published one. |
| `services[].methods[].apiCalls` | Service method → HTTP verb + URL template |
| `events[].handler` → `apiCalls` | Which calls a click transitively causes |

**This is the one thing the syntactic pass cannot do.** Resolving a handler through an injected
service into an `HttpClient.post(...)` is a cross-file call graph, which needs a real `Program`. So it
belongs behind its own flag (`--deep`, or a separate package), where a consumer opts into the tsconfig
load, the slower run, and the requirement that the project actually compiles — none of which the
default path should ever inherit.

Emit `resolved: false` rather than a half-resolved URL when the template is assembled from variables
the analyser could not follow. A URL that looks resolved and is not is worse than an absent one.

---

## Sequencing notes

**Phases 1 and 2 are the ones that change what is possible.** Everything after makes an existing
answer better; those two make joining work at all, and neither is expensive. If only two phases ever
land, they are the two.

**Phase 3 is cheap but has to be designed, not bolted on.** The data is already in the parse result;
the decision is where to put it so the diff promise survives.

**Node collapsing belongs with Phase 4.** In the reference Angular app, 47% of element nodes are
presentational wrappers — a `div`/`span` with only a `class`, no events, no props, no identifying
attribute — and folding their static text into the parent removes another third. That is a ~70%
reduction with no loss to any consumer *once `conditionChain` is denormalized*, because the only
reason to keep a wrapper node is to walk ancestors for its condition. Do it as a `nodePolicy` field
so the output states which policy produced it; do not do it before Phase 4, or conditions are lost.

**Version discipline.** The package is 0.1.x, so breaking changes are cheap *now* and expensive after
1.0. Phase 1 sets `schemaVersion: "2.0"` and is the right moment to make required fields required.
Everything from Phase 2 on is additive and needs no further bump.
