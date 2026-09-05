import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DomNode, ElementNode, StructuralKind, TemplateBranch, TemplateNode } from '@ui-manifest-json/core';

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
  | { ok: true; dom: DomNode[]; diagnostics: string[] }
  | { ok: false; error: string };

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
export async function parseComponentDom(templateSource: string, urlForErrors: string): Promise<DomParseResult> {
  const ng = await loadCompiler();
  const parsed = ng.parseTemplate(templateSource, urlForErrors, { preserveWhitespaces: false });
  if (parsed.errors && parsed.errors.length) {
    return { ok: false, error: parsed.errors.map(e => e.msg).join('; ') };
  }
  const diagnostics: string[] = [];
  const dom = parsed.nodes
    .map(node => nodeToPlain(node, ng, urlForErrors, diagnostics))
    .filter((n): n is DomNode => n !== null);
  return { ok: true, dom, diagnostics };
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

function nodeToPlain(node: TmplAstNode, ng: Compiler, filePath: string, diagnostics: string[]): DomNode | null {
  if (node instanceof ng.TmplAstText) {
    const text = node.value.trim();
    return text ? { type: 'text', extraction: 'compiler', value: text } : null;
  }
  if (node instanceof ng.TmplAstBoundText) {
    return { type: 'interpolation', extraction: 'compiler', interpolation: exprSource(node.value) };
  }
  if (node instanceof ng.TmplAstElement) {
    return elementToPlain(node, ng, filePath, diagnostics);
  }
  if (node instanceof ng.TmplAstTemplate) {
    return templateToPlain(node, ng, filePath, diagnostics);
  }
  if (node instanceof ng.TmplAstContent) {
    return contentToPlain(node, ng, filePath, diagnostics);
  }
  if (node instanceof ng.TmplAstIfBlock) {
    return ifBlockToPlain(node, ng, filePath, diagnostics);
  }
  if (node instanceof ng.TmplAstForLoopBlock) {
    return forLoopToPlain(node, ng, filePath, diagnostics);
  }
  if (node instanceof ng.TmplAstSwitchBlock) {
    return switchToPlain(node, ng, filePath, diagnostics);
  }
  if (node instanceof ng.TmplAstDeferredBlock) {
    return deferToPlain(node, ng, filePath, diagnostics);
  }
  // Everything else (Comment, Icu, UnknownBlock, `@let` LetDeclaration, ...) has no DomNode
  // variant that fits without distorting the fixed core schema — skip it and say so, rather than
  // silently dropping information or inventing a mismatched shape.
  diagnostics.push(`unsupported template node kind "${node.constructor.name}" skipped in ${filePath}`);
  return null;
}

function childrenToPlain(nodes: TmplAstNode[], ng: Compiler, filePath: string, diagnostics: string[]): DomNode[] {
  return nodes.map(child => nodeToPlain(child, ng, filePath, diagnostics)).filter(isNotNull);
}

function elementToPlain(node: ElementAst, ng: Compiler, filePath: string, diagnostics: string[]): ElementNode {
  const attrs: Record<string, string> = {};
  for (const a of node.attributes) attrs[a.name] = a.value;
  const props = node.inputs.map(i => ({ name: i.keySpan?.toString() ?? i.name, expr: exprSource(i.value) }));
  const events = node.outputs.map(o => ({ name: o.keySpan?.toString() ?? o.name, expr: exprSource(o.handler) }));
  const refs = node.references.map(r => r.name);
  return {
    type: 'element',
    extraction: 'compiler',
    el: node.name,
    attrs,
    props,
    events,
    ...(refs.length ? { refs } : {}),
    children: childrenToPlain(node.children, ng, filePath, diagnostics),
  };
}

function contentToPlain(node: ContentAst, ng: Compiler, filePath: string, diagnostics: string[]): ElementNode {
  const attrs: Record<string, string> = {};
  if (node.selector && node.selector !== '*') attrs.select = node.selector;
  // `TmplAstContent` gained `children` after Angular 17: back then `<ng-content>` was
  // self-closing by construction and the class had no such property, so reading it threw
  // `Cannot read properties of undefined (reading 'map')` for every template containing an
  // `<ng-content>` — which is most component libraries. Same family as `switchGroups` above, and
  // found the same way: installing the packed tarball against each version in the declared peer
  // range. Empty is not a fallback here, it is what the old shape MEANS.
  const children = (node as { children?: unknown[] }).children ?? [];
  return {
    type: 'element',
    extraction: 'compiler',
    el: 'ng-content',
    attrs,
    props: [],
    events: [],
    children: childrenToPlain(children as Parameters<typeof childrenToPlain>[0], ng, filePath, diagnostics),
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

function templateToPlain(node: TemplateAst, ng: Compiler, filePath: string, diagnostics: string[]): TemplateNode {
  const { kind, condition } = legacyStructuralKind(node.templateAttrs);
  return {
    type: 'template',
    extraction: 'compiler',
    structural: kind,
    ...(condition !== undefined ? { condition } : {}),
    children: childrenToPlain(node.children, ng, filePath, diagnostics),
  };
}

function ifBlockToPlain(node: IfBlockAst, ng: Compiler, filePath: string, diagnostics: string[]): TemplateNode {
  const branches: TemplateBranch[] = node.branches.map((b, i) => ({
    label: b.expression ? (i === 0 ? 'if' : 'else if') : 'else',
    ...(b.expression ? { condition: exprSource(b.expression) } : {}),
    children: childrenToPlain(b.children, ng, filePath, diagnostics),
  }));
  const primary = branches[0] as TemplateBranch | undefined;
  return {
    type: 'template',
    extraction: 'compiler',
    structural: '@if',
    ...(primary?.condition !== undefined ? { condition: primary.condition } : {}),
    branches,
    children: primary?.children ?? [],
  };
}

function forLoopToPlain(node: ForLoopBlockAst, ng: Compiler, filePath: string, diagnostics: string[]): TemplateNode {
  const of = exprSource(node.expression);
  const trackBy = node.trackBy ? exprSource(node.trackBy) : undefined;
  const condition = `${node.item.name} of ${of}${trackBy ? `; track ${trackBy}` : ''}`;
  const branches: TemplateBranch[] | undefined = node.empty
    ? [{ label: 'empty', children: childrenToPlain(node.empty.children, ng, filePath, diagnostics) }]
    : undefined;
  return {
    type: 'template',
    extraction: 'compiler',
    structural: '@for',
    condition,
    ...(branches ? { branches } : {}),
    children: childrenToPlain(node.children, ng, filePath, diagnostics),
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

function switchToPlain(node: SwitchBlockAst, ng: Compiler, filePath: string, diagnostics: string[]): TemplateNode {
  const branches: TemplateBranch[] = switchGroups(node).map(g => {
    const isDefault = g.cases.length === 0 || g.cases.every(c => c.expression === null);
    const label = isDefault
      ? 'default'
      : g.cases.map(c => exprSource(c.expression as Parameters<typeof exprSource>[0])).join(', ');
    return {
      label,
      ...(isDefault ? {} : { condition: label }),
      children: childrenToPlain(g.children as Parameters<typeof childrenToPlain>[0], ng, filePath, diagnostics),
    };
  });
  return {
    type: 'template',
    extraction: 'compiler',
    structural: '@switch',
    condition: exprSource(node.expression),
    branches,
    children: (branches[0] as TemplateBranch | undefined)?.children ?? [],
  };
}

function deferToPlain(node: DeferredBlockAst, ng: Compiler, filePath: string, diagnostics: string[]): TemplateNode {
  const triggers = Object.keys(node.triggers ?? {});
  const branches: TemplateBranch[] = [];
  if (node.placeholder) {
    branches.push({ label: 'placeholder', children: childrenToPlain(node.placeholder.children, ng, filePath, diagnostics) });
  }
  if (node.loading) {
    branches.push({ label: 'loading', children: childrenToPlain(node.loading.children, ng, filePath, diagnostics) });
  }
  if (node.error) {
    branches.push({ label: 'error', children: childrenToPlain(node.error.children, ng, filePath, diagnostics) });
  }
  return {
    type: 'template',
    extraction: 'compiler',
    structural: '@defer',
    ...(triggers.length ? { condition: triggers.join(', ') } : {}),
    ...(branches.length ? { branches } : {}),
    children: childrenToPlain(node.children, ng, filePath, diagnostics),
  };
}
