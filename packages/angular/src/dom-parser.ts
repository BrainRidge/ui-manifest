import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  BoundExpr, DomNode, ElementNode, SourcePointer, StructuralKind, TemplateBranch, TemplateNode,
} from '@ui-manifest-json/core';
import { collapseDom, enrichDom } from '@ui-manifest-json/core';

// `@angular/compiler` is an optional peer dependency: it must never be imported at module load
// time, only lazily (and cached) the first time DOM parsing is actually requested (--with-dom).
type Compiler = typeof import('@angular/compiler');
let compilerPromise: Promise<Compiler> | undefined;
function loadCompiler(): Promise<Compiler> {
  compilerPromise ??= import('@angular/compiler');
  return compilerPromise;
}

// Derive the exact node union `parseTemplate()` produces from the compiler's own types, rather
// than naming its internal (unexported) `Node` interface ourselves.
type ParsedTemplateNodes = ReturnType<Compiler['parseTemplate']>['nodes'];
type TmplAstNode = ParsedTemplateNodes[number];
type ElementAst = InstanceType<Compiler['TmplAstElement']>;
type TemplateAst = InstanceType<Compiler['TmplAstTemplate']>;
type ContentAst = InstanceType<Compiler['TmplAstContent']>;
type IfBlockAst = InstanceType<Compiler['TmplAstIfBlock']>;
type ForLoopBlockAst = InstanceType<Compiler['TmplAstForLoopBlock']>;
type SwitchBlockAst = InstanceType<Compiler['TmplAstSwitchBlock']>;
type DeferredBlockAst = InstanceType<Compiler['TmplAstDeferredBlock']>;
type TemplateAttrAst = TemplateAst['templateAttrs'][number];

export type DomParseResult =
  | { ok: true; dom: DomNode[]; diagnostics: string[]; collapsed: number }
  | { ok: false; error: string };

/**
 * Where a template's text actually lives, so a parsed node's position can be turned into a
 * repo-relative file and line.
 *
 * `lineOffset` is what makes an INLINE template honest. `parseTemplate()` numbers lines from the
 * start of the string it was handed, so an inline `template: \`...\`` starting at line 14 of a
 * `.component.ts` reports its first element as line 0 — which points at the import block. The
 * offset is the line the template literal opens on, and without it every pointer into an inline
 * template is confidently wrong rather than merely absent.
 */
export interface TemplateOrigin {
  /** Repo-relative path of the file the template text lives in — the `.html` for a `templateUrl`,
   *  the `.component.ts` for an inline one. */
  path: string;
  /** 0-based line within `path` that the template text starts on. */
  lineOffset: number;
}

interface Ctx {
  ng: Compiler;
  origin: TemplateOrigin;
  diagnostics: string[];
}

/** Angular's spans are 0-based; editors, git and humans are 1-based. Convert once, here. */
function pointerFor(ctx: Ctx, span: { start: { line: number }; end: { line: number } } | undefined): SourcePointer | undefined {
  if (!span) return undefined;
  return {
    path: ctx.origin.path,
    startLine: ctx.origin.lineOffset + span.start.line + 1,
    endLine: ctx.origin.lineOffset + span.end.line + 1,
  };
}

/** Resolve the raw template source text for a component: read the external file for
 *  `templateUrl` (relative to the component's own file, like Angular itself resolves it), or use
 *  the inline `template: \`...\`` string. Returns null if neither is available/readable. */
export function resolveTemplateSource(
  templateUrl: string | undefined,
  inlineTemplateText: string | undefined,
  componentAbsPath: string,
): string | null {
  if (templateUrl) {
    try {
      return readFileSync(resolve(dirname(componentAbsPath), templateUrl), 'utf8');
    } catch {
      return null;
    }
  }
  if (inlineTemplateText != null) return inlineTemplateText;
  return null;
}

/** Parse one component's template source into the `DomNode[]` shape via a real Ivy
 *  `parseTemplate()` call. `urlForErrors` is only used for source-mapping inside compiler error
 *  messages — it is not stored in the output. */
export async function parseComponentDom(
  templateSource: string,
  urlForErrors: string,
  origin: TemplateOrigin = { path: urlForErrors, lineOffset: 0 },
): Promise<DomParseResult> {
  const ng = await loadCompiler();
  const parsed = ng.parseTemplate(templateSource, urlForErrors, { preserveWhitespaces: false });
  if (parsed.errors && parsed.errors.length) {
    return { ok: false, error: parsed.errors.map(e => e.msg).join('; ') };
  }
  const ctx: Ctx = { ng, origin, diagnostics: [] };
  const dom = parsed.nodes
    .map(node => nodeToPlain(node, ctx))
    .filter((n): n is DomNode => n !== null);
  // Collapse BEFORE enrichment, so text folding and uniqueness both measure the tree a consumer
  // will actually read rather than the one the parser happened to produce.
  const { dom: kept, collapsed } = collapseDom(dom);
  // Enrichment runs over the WHOLE template at once, not per node, because two of its rules are
  // whole-template properties: a candidate's uniqueness is only meaningful against every other
  // element in the file, and an element's condition chain is a property of its ancestors.
  enrichDom(kept);
  return { ok: true, dom: kept, diagnostics: ctx.diagnostics, collapsed };
}

// Only `ASTWithSource` instances carry `.source`; the various AST-typed fields on template nodes
// (BoundAttribute.value, BoundEvent.handler, IfBlockBranch.expression, ...) are declared as the
// weaker base `AST` type, which has no properties in common with `.source` structurally — hence
// `unknown` plus a runtime property check here, rather than a statically-typed accessor.
function exprSource(ast: unknown): string {
  if (ast && typeof ast === 'object' && 'source' in ast) {
    const source = (ast as { source?: string | null }).source;
    return typeof source === 'string' ? source : '';
  }
  return '';
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

function nodeToPlain(node: TmplAstNode, ctx: Ctx): DomNode | null {
  if (node instanceof ctx.ng.TmplAstText) {
    const text = node.value.trim();
    return text ? { type: 'text', extraction: 'compiler', value: text } : null;
  }
  if (node instanceof ctx.ng.TmplAstBoundText) {
    return { type: 'interpolation', extraction: 'compiler', interpolation: exprSource(node.value) };
  }
  if (node instanceof ctx.ng.TmplAstElement) {
    return elementToPlain(node, ctx);
  }
  if (node instanceof ctx.ng.TmplAstTemplate) {
    return templateToPlain(node, ctx);
  }
  if (node instanceof ctx.ng.TmplAstContent) {
    return contentToPlain(node, ctx);
  }
  if (node instanceof ctx.ng.TmplAstIfBlock) {
    return ifBlockToPlain(node, ctx);
  }
  if (node instanceof ctx.ng.TmplAstForLoopBlock) {
    return forLoopToPlain(node, ctx);
  }
  if (node instanceof ctx.ng.TmplAstSwitchBlock) {
    return switchToPlain(node, ctx);
  }
  if (node instanceof ctx.ng.TmplAstDeferredBlock) {
    return deferToPlain(node, ctx);
  }
  // Everything else (Comment, Icu, UnknownBlock, `@let` LetDeclaration, ...) has no DomNode
  // variant that fits without distorting the fixed core schema — skip it and say so, rather than
  // silently dropping information or inventing a mismatched shape.
  ctx.diagnostics.push(`unsupported template node kind "${node.constructor.name}" skipped in ${ctx.origin.path}`);
  return null;
}

function childrenToPlain(nodes: TmplAstNode[], ctx: Ctx): DomNode[] {
  return nodes.map(child => nodeToPlain(child, ctx)).filter(isNotNull);
}

/**
 * Split a `[(banana)]` binding back into the two halves Angular desugars it into.
 *
 * `[(ngModel)]="x"` produces an input named `ngModel` AND an output named `ngModelChange`, and in
 * v2 the second was indistinguishable from a hand-written `(ngModelChange)` handler — so anything
 * counting interactions counted every two-way-bound field twice. Detected structurally (an output
 * named `<input>Change` for an input that exists) rather than off `ParsedEventType`, because that
 * enum is internal to the compiler and this package supports five major versions of it.
 */
function eventKind(inputNames: Set<string>, outputName: string): 'output' | 'twoWayWriteback' {
  const base = outputName.endsWith('Change') ? outputName.slice(0, -'Change'.length) : '';
  return base && inputNames.has(base) ? 'twoWayWriteback' : 'output';
}

function elementToPlain(node: ElementAst, ctx: Ctx): ElementNode {
  const attrs: Record<string, string> = {};
  for (const a of node.attributes) attrs[a.name] = a.value;
  const inputNames = new Set(node.inputs.map(i => i.name));
  const twoWay = new Set(node.outputs.map(o => o.name).filter(n => n.endsWith('Change'))
    .map(n => n.slice(0, -'Change'.length)).filter(n => inputNames.has(n)));
  const props: BoundExpr[] = node.inputs.map(i => ({
    name: i.keySpan?.toString() ?? i.name,
    expr: exprSource(i.value),
    ...(twoWay.has(i.name) ? { kind: 'twoWay' as const } : {}),
  }));
  const events: BoundExpr[] = node.outputs.map(o => ({
    name: o.keySpan?.toString() ?? o.name,
    expr: exprSource(o.handler),
    kind: eventKind(inputNames, o.name),
  }));
  const refs = node.references.map(r => r.name);
  const source = pointerFor(ctx, node.sourceSpan);
  return {
    type: 'element',
    extraction: 'compiler',
    el: node.name,
    attrs,
    props,
    events,
    ...(refs.length ? { refs } : {}),
    children: childrenToPlain(node.children, ctx),
    ...(source ? { source } : {}),
  };
}

function contentToPlain(node: ContentAst, ctx: Ctx): ElementNode {
  const attrs: Record<string, string> = {};
  if (node.selector && node.selector !== '*') attrs.select = node.selector;
  // `TmplAstContent` gained `children` after Angular 17: back then `<ng-content>` was
  // self-closing by construction and the class had no such property, so reading it threw
  // `Cannot read properties of undefined (reading 'map')` for every template containing an
  // `<ng-content>` — which is most component libraries. Same family as `switchGroups` above, and
  // found the same way: installing the packed tarball against each version in the declared peer
  // range. Empty is not a fallback here, it is what the old shape MEANS.
  const children = (node as { children?: unknown[] }).children ?? [];
  const source = pointerFor(ctx, node.sourceSpan);
  return {
    type: 'element',
    extraction: 'compiler',
    el: 'ng-content',
    attrs,
    props: [],
    events: [],
    children: childrenToPlain(children as Parameters<typeof childrenToPlain>[0], ctx),
    ...(source ? { source } : {}),
  };
}

function attrValueSource(attr: TemplateAttrAst): string {
  return typeof attr.value === 'string' ? attr.value : exprSource(attr.value);
}

/**
 * v1 limitation (documented, not a bug): only `*ngIf` and `*ngFor` are individually recognized
 * among legacy structural directives. Anything else applied via `*directive="..."` syntax (e.g.
 * `*ngSwitchCase`, `*ngTemplateOutlet`, or a bare `<ng-template>` with no structural directive at
 * all) is bucketed as `*ngIf` so the node still round-trips through the fixed `StructuralKind`
 * enum, with its raw `templateAttrs` folded into `condition` instead of silently lost.
 */
function legacyStructuralKind(templateAttrs: TemplateAttrAst[]): { kind: StructuralKind; condition?: string } {
  const byName = (name: string) => templateAttrs.find(a => a.name === name);
  const ngIf = byName('ngIf');
  if (ngIf) return { kind: '*ngIf', condition: attrValueSource(ngIf) };
  // `*ngFor="let item of items"` desugars into a `TextAttribute` named "ngFor" (empty value —
  // just a presence marker) plus the actual iterable as a separate `BoundAttribute` named
  // "ngForOf". The item name itself lives in `Template.variables`, not `templateAttrs`, and is
  // dropped here — `condition` mirrors `*ngIf`'s "just the guiding expression" shape.
  const ngForOf = byName('ngForOf');
  if (ngForOf || byName('ngFor')) return { kind: '*ngFor', condition: ngForOf ? attrValueSource(ngForOf) : undefined };
  const condition = templateAttrs.map(a => `${a.name}=${attrValueSource(a)}`).join('; ');
  return { kind: '*ngIf', condition: condition || undefined };
}

function templateToPlain(node: TemplateAst, ctx: Ctx): TemplateNode {
  const { kind, condition } = legacyStructuralKind(node.templateAttrs);
  const source = pointerFor(ctx, node.sourceSpan);
  return {
    type: 'template',
    extraction: 'compiler',
    structural: kind,
    ...(condition !== undefined ? { condition } : {}),
    children: childrenToPlain(node.children, ctx),
    ...(source ? { source } : {}),
  };
}

function ifBlockToPlain(node: IfBlockAst, ctx: Ctx): TemplateNode {
  const branches: TemplateBranch[] = node.branches.map((b, i) => ({
    label: b.expression ? (i === 0 ? 'if' : 'else if') : 'else',
    ...(b.expression ? { condition: exprSource(b.expression) } : {}),
    children: childrenToPlain(b.children, ctx),
  }));
  const primary = branches[0] as TemplateBranch | undefined;
  const source = pointerFor(ctx, node.sourceSpan);
  return {
    type: 'template',
    extraction: 'compiler',
    structural: '@if',
    ...(primary?.condition !== undefined ? { condition: primary.condition } : {}),
    branches,
    children: primary?.children ?? [],
    ...(source ? { source } : {}),
  };
}

function forLoopToPlain(node: ForLoopBlockAst, ctx: Ctx): TemplateNode {
  const of = exprSource(node.expression);
  const trackBy = node.trackBy ? exprSource(node.trackBy) : undefined;
  const condition = `${node.item.name} of ${of}${trackBy ? `; track ${trackBy}` : ''}`;
  const branches: TemplateBranch[] | undefined = node.empty
    ? [{ label: 'empty', children: childrenToPlain(node.empty.children, ctx) }]
    : undefined;
  const source = pointerFor(ctx, node.sourceSpan);
  return {
    type: 'template',
    extraction: 'compiler',
    structural: '@for',
    condition,
    ...(branches ? { branches } : {}),
    children: childrenToPlain(node.children, ctx),
    ...(source ? { source } : {}),
  };
}

/**
 * One `@switch` branch, normalised across the two shapes Angular's AST has had.
 *
 * A group holds the several `@case`s that FALL THROUGH to one body, plus that body.
 */
export interface SwitchGroup {
  cases: { expression: unknown }[];
  children: unknown[];
}

/**
 * Angular 22 renamed `SwitchBlock.cases` to `.groups` and changed its element type, and this
 * package declares `@angular/compiler: ">=17.0.0"`. Reading only the new shape threw
 * `Cannot read properties of undefined (reading 'map')` on **every `@switch` block** for anyone on
 * 17–21 — which is most users, and was invisible here because the monorepo's own devDependency is
 * 22.x. Found by installing the packed tarball into a clean project against Angular 19, the same
 * way the `typescript` 7.x peer break was found.
 *
 * The two shapes are not merely renamed. Pre-22 each `SwitchBlockCase` is one case with its own
 * `children`; from 22 a `SwitchBlockCaseGroup` holds several `cases` sharing one `children`, which
 * is how `@case (a) @case (b) { … }` fall-through is represented. The 22 model is strictly richer,
 * so normalising OLD onto NEW is lossless — each old case becomes a group of exactly one.
 *
 * Feature-detected on the value, not the version: the compiler is an optional peer dependency
 * resolved by the consumer, so its version is not something this package can know, and reading the
 * property that exists is both simpler and correct across any future rename in either direction.
 */
export function switchGroups(node: SwitchBlockAst): SwitchGroup[] {
  const withGroups = node as unknown as { groups?: SwitchGroup[] };
  if (Array.isArray(withGroups.groups)) return withGroups.groups;

  const legacy = node as unknown as { cases?: { expression: unknown; children: unknown[] }[] };
  return (legacy.cases ?? []).map(c => ({ cases: [c], children: c.children }));
}

function switchToPlain(node: SwitchBlockAst, ctx: Ctx): TemplateNode {
  const branches: TemplateBranch[] = switchGroups(node).map(g => {
    const isDefault = g.cases.length === 0 || g.cases.every(c => c.expression === null);
    const label = isDefault
      ? 'default'
      : g.cases.map(c => exprSource(c.expression as Parameters<typeof exprSource>[0])).join(', ');
    return {
      label,
      ...(isDefault ? {} : { condition: label }),
      children: childrenToPlain(g.children as Parameters<typeof childrenToPlain>[0], ctx),
    };
  });
  const source = pointerFor(ctx, node.sourceSpan);
  return {
    type: 'template',
    extraction: 'compiler',
    structural: '@switch',
    condition: exprSource(node.expression),
    branches,
    children: (branches[0] as TemplateBranch | undefined)?.children ?? [],
    ...(source ? { source } : {}),
  };
}

function deferToPlain(node: DeferredBlockAst, ctx: Ctx): TemplateNode {
  const triggers = Object.keys(node.triggers ?? {});
  const branches: TemplateBranch[] = [];
  if (node.placeholder) {
    branches.push({ label: 'placeholder', children: childrenToPlain(node.placeholder.children, ctx) });
  }
  if (node.loading) {
    branches.push({ label: 'loading', children: childrenToPlain(node.loading.children, ctx) });
  }
  if (node.error) {
    branches.push({ label: 'error', children: childrenToPlain(node.error.children, ctx) });
  }
  const source = pointerFor(ctx, node.sourceSpan);
  return {
    type: 'template',
    extraction: 'compiler',
    structural: '@defer',
    ...(triggers.length ? { condition: triggers.join(', ') } : {}),
    ...(branches.length ? { branches } : {}),
    children: childrenToPlain(node.children, ctx),
    ...(source ? { source } : {}),
  };
}
