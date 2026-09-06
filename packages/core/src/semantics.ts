/**
 * The pass that turns a raw parse tree into something a consumer can JOIN against a live DOM.
 *
 * Framework-agnostic on purpose: both extractors produce the same `DomNode` union, and every rule
 * here reads only that union. Angular's parser and React's differ entirely in how they find a
 * conditional; by the time a tree reaches this module the conditional is a `TemplateNode` either
 * way.
 *
 * Three things happen here, and each removes work a consumer would otherwise have to do — wrongly,
 * and once per consumer:
 *
 * **Static text is folded into its element.** A `<button>Sign In</button>` parses as an element
 * with a text child. Keyed on its own, that button has no handle at all: no id, no name, no
 * testid — which describes most buttons in most apps. Folding the text up is what makes it
 * addressable. An interpolation is deliberately NOT folded: a key built from `{{ user.name }}`
 * changes with the test data.
 *
 * **Ancestry is denormalized.** Every structural branch between the root and an element is copied
 * onto that element as `conditionChain`. This is what lets the tree drop presentational wrappers
 * without losing anything, and it is what turns "why is this field not on the page?" from a
 * repository search into a field read.
 *
 * **Handles are enumerated, and their absence is reported.** `tokenStability: "none"` on a control
 * means the source offers no stable way to address it. With a file and a line attached, that is
 * the single most actionable line this whole format produces: *add a `data-testid` here*.
 */
import type {
  ConditionLink, ControlType, DomNode, ElementNode, SelectorCandidate, TemplateNode,
} from './types/dom.js';

/** Attributes that make an element addressable, and so make it worth keeping. */
const MEANINGFUL_ATTRS = [
  'id', 'name', 'placeholder', 'role', 'title', 'href', 'src', 'type', 'value', 'for',
  'routerLink', 'formControlName', 'formGroupName', 'formArrayName',
];

/**
 * A node that exists only to position other nodes.
 *
 * The rule is narrow on purpose. A `div` holding nothing but a class and OTHER ELEMENTS is
 * layout; a `div` holding text is the text's element, and dropping it would leave the text with
 * nothing to hang on — including, decisively, nothing for a `conditionChain` to be attached to.
 * `<div class="error-message">{{ errorMessage }}</div>` under an `*ngIf` is the whole answer to
 * "why is this not on the page?", and it looks exactly like a wrapper until you notice it wraps
 * no element.
 */
function isPresentationalWrapper(node: ElementNode): boolean {
  const tag = node.el.toLowerCase();
  if (tag !== 'div' && tag !== 'span') return false;
  if (node.el.includes('-')) return false;
  if (node.events.length || node.props.length) return false;
  if (node.refs?.length) return false;
  for (const key of Object.keys(node.attrs)) {
    if (key === 'class' || key === 'style') continue;
    if (key.startsWith('aria-') || key.startsWith('data-')) return false;
    if (MEANINGFUL_ATTRS.includes(key)) return false;
    return false;
  }
  // It must wrap at least one ELEMENT, and carry no text of its own.
  const hasElementChild = node.children.some(c => c.type === 'element' || c.type === 'template');
  const hasOwnText = node.children.some(c => c.type === 'text' || c.type === 'interpolation');
  return hasElementChild && !hasOwnText;
}

/**
 * Drop presentational wrappers, splicing their children into their place.
 *
 * Safe only because `conditionChain` is denormalized onto every element: nothing downstream needs
 * the ancestors this removes. Run BEFORE enrichment so text folding and uniqueness both see the
 * final tree. Returns how many nodes went, because a consumer must be able to tell that the tree
 * it is reading is not the DOM.
 */
export function collapseDom(nodes: DomNode[]): { dom: DomNode[]; collapsed: number } {
  let collapsed = 0;

  const rewrite = (list: DomNode[]): DomNode[] => {
    const out: DomNode[] = [];
    for (const node of list) {
      if (node.type === 'template') {
        node.children = rewrite(node.children);
        for (const branch of node.branches ?? []) branch.children = rewrite(branch.children);
        out.push(node);
        continue;
      }
      if (node.type !== 'element') {
        out.push(node);
        continue;
      }
      node.children = rewrite(node.children);
      if (isPresentationalWrapper(node)) {
        collapsed += 1;
        out.push(...node.children);
        continue;
      }
      out.push(node);
    }
    return out;
  };

  return { dom: rewrite(nodes), collapsed };
}

/** The attribute names a test-id may be spelled with, in the order a consumer should prefer. */
export const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'] as const;

export function testidOf(attrs: Record<string, string>): string | undefined {
  for (const name of TESTID_ATTRS) {
    const value = attrs[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Tags that are interactive by nature, so an element bearing one is a control even with no role. */
const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button', 'a', 'option']);

/**
 * What a person can DO with this element.
 *
 * Driven off the tag and `type` rather than the role attribute, because the role is usually
 * absent and the tag almost never is. `<input type="submit">` is a BUTTON — it is spelled as an
 * input but it submits, and treating it as a textbox is how a submit control ends up expected to
 * accept typing.
 */
export function controlTypeFor(el: string, attrs: Record<string, string>): ControlType | undefined {
  const tag = el.toLowerCase();
  const type = (attrs.type ?? '').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return attrs.multiple !== undefined ? 'listbox' : 'combobox';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'fileinput';
    if (type === 'range') return 'slider';
    if (type === 'date' || type === 'datetime-local' || type === 'month' || type === 'week') return 'datepicker';
    // submit/button/reset/image are buttons wearing an input's tag.
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
    return 'textbox';
  }
  const role = (attrs.role ?? '').toLowerCase();
  if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio'
      || role === 'combobox' || role === 'listbox' || role === 'textbox' || role === 'tab'
      || role === 'grid' || role === 'slider') {
    return role as ControlType;
  }
  return undefined;
}

function isControl(node: ElementNode): boolean {
  const tag = node.el.toLowerCase();
  if (CONTROL_TAGS.has(tag)) return true;
  if (node.attrs.role) return true;
  // A custom element wired to a click is a control however it is spelled.
  return node.events.some(e => e.kind !== 'twoWayWriteback');
}

/** Every handle the SOURCE offers for this element, best first. Audit material, not a locator. */
export function selectorCandidatesFor(node: ElementNode, staticText?: string): SelectorCandidate[] {
  const out: SelectorCandidate[] = [];
  const { attrs } = node;
  const tag = node.el.toLowerCase();
  const push = (by: SelectorCandidate['by'], value: string) =>
    out.push({ by, value, unique: false, uniqueScope: 'template' });

  const testid = testidOf(attrs);
  if (testid) push('testid', `[data-testid="${testid}"]`);
  if (attrs.id) push('id', `#${attrs.id}`);
  if (attrs.name) push('name', `${tag}[name="${attrs.name}"]`);
  if (attrs['aria-label']) push('aria', `${tag}[aria-label="${attrs['aria-label']}"]`);
  if (attrs.placeholder) push('placeholder', `${tag}[placeholder="${attrs.placeholder}"]`);
  if (staticText) push('text', staticText);
  return out;
}

/**
 * Mark which candidates are unique WITHIN THIS TEMPLATE.
 *
 * Scoped to the template and labelled as such, because that is the only claim a static pass can
 * honestly make: one page is composed of a shell plus a route component, so a value unique in its
 * own file can still collide once rendered. Saying `uniqueScope: "template"` is the difference
 * between a weaker claim and a wrong one.
 */
function markUniqueness(elements: ElementNode[]): void {
  const counts = new Map<string, number>();
  for (const el of elements) {
    for (const c of el.selectorCandidates ?? []) {
      counts.set(`${c.by} ${c.value}`, (counts.get(`${c.by} ${c.value}`) ?? 0) + 1);
    }
  }
  for (const el of elements) {
    for (const c of el.selectorCandidates ?? []) {
      c.unique = counts.get(`${c.by} ${c.value}`) === 1;
    }
  }
}

/**
 * Does this element carry a stable handle, an expression-derived one, or none at all?
 *
 * `none` is the interesting answer and the reason this field exists: reported with a file and a
 * line it becomes an actionable finding, where the same element simply missing from a join reads
 * as noise.
 */
function tokenStabilityFor(node: ElementNode, staticText?: string): ElementNode['tokenStability'] {
  const { attrs } = node;
  if (testidOf(attrs) || attrs.id || attrs.name || attrs['aria-label'] || attrs.placeholder || staticText) {
    return 'static';
  }
  const dynamic = node.props.find(p =>
    p.name === 'id' || p.name === 'attr.id' || p.name === 'name' || p.name === 'attr.name'
    || TESTID_ATTRS.some(t => p.name === t || p.name === `attr.${t}`));
  if (dynamic) return 'dynamic';
  return isControl(node) ? 'none' : undefined;
}

/** The literal prefix of a dynamic handle, e.g. `[attr.id]="'tx-' + tx.id"`. */
function tokenTemplateFor(node: ElementNode): string | undefined {
  const dynamic = node.props.find(p =>
    p.name === 'id' || p.name === 'attr.id'
    || TESTID_ATTRS.some(t => p.name === t || p.name === `attr.${t}`));
  if (!dynamic) return undefined;
  const literal = /^\s*['"]([^'"]+)['"]\s*\+/.exec(dynamic.expr);
  return literal ? `${literal[1]}{{*}}` : undefined;
}

/**
 * An accessible name, and ONLY when the source actually declares one.
 *
 * Deliberately not falling back to `staticText`, which is the obvious version and is wrong. A
 * consumer keys an element on the best handle it has, and an accessible name outranks raw text —
 * so synthesising one from a caption turns `<button>Sign In</button>` into an `aria:Sign In` key,
 * while a browser recording the same button (it has no `aria-label`) produces a `text:Sign In`
 * one. The two never join, and they fail to join on exactly the elements whose only handle is
 * their caption. `staticText` carries the caption; let the consumer decide what it is worth.
 */
function accessibleNameFor(node: ElementNode): string | undefined {
  return node.attrs['aria-label'] || node.attrs.title || undefined;
}

function isTruthyAttr(value: string | undefined): boolean {
  return value !== undefined && value !== 'false';
}

/** The gate a `TemplateNode` represents, as one link in a chain. */
function linkFor(node: TemplateNode, branch?: string): ConditionLink {
  return {
    directive: node.structural,
    expr: node.condition ?? '',
    ...(branch ? { branch } : {}),
    ...(node.source ? { source: node.source } : {}),
  };
}

/** `@for`'s condition is written `item of items; track id` — split it back apart. */
function repeatPartsOf(condition: string | undefined): { over?: string; varName?: string; trackBy?: string } {
  if (!condition) return {};
  const match = /^\s*(\S+)\s+of\s+([^;]+?)\s*(?:;\s*track\s+(.+))?\s*$/.exec(condition);
  if (!match) return { over: condition.trim() || undefined };
  return { varName: match[1], over: match[2]?.trim(), trackBy: match[3]?.trim() };
}

type RepeatState = ReturnType<typeof repeatPartsOf> & { on: boolean };

/**
 * Walk a parsed tree and enrich every element in place.
 *
 * Returns every element it visited, in template order, so the caller can run whole-template passes
 * (uniqueness) without walking again. Order is template order because two elements sharing a
 * handle should collide in a stable order rather than whichever the walk happened to reach first.
 */
export function enrichDom(nodes: DomNode[]): ElementNode[] {
  const seen: ElementNode[] = [];

  const walk = (list: DomNode[], chain: ConditionLink[], repeat: RepeatState): void => {
    for (const node of list) {
      if (node.type === 'template') {
        const t = node as TemplateNode;
        const isFor = t.structural === '@for' || t.structural === '*ngFor' || t.structural === '.map()';
        const parts = isFor ? repeatPartsOf(t.condition) : {};
        const nextRepeat: RepeatState = isFor ? { ...parts, on: true } : repeat;

        // The primary branch's children hang off `children`; every other branch off `branches`.
        // `branches[0]` IS `children` for an @if/@switch, so walking both would visit the primary
        // twice and give its elements a duplicated chain link.
        walk(t.children, [...chain, linkFor(t)], nextRepeat);
        for (const branch of (t.branches ?? []).slice(1)) {
          walk(branch.children, [...chain, linkFor(t, branch.label)], nextRepeat);
        }
        continue;
      }
      if (node.type !== 'element') continue;

      const el = node as ElementNode;
      const staticParts: string[] = [];
      let hasDynamicText = false;
      for (const child of el.children) {
        if (child.type === 'text' && child.value.trim()) staticParts.push(child.value.trim());
        if (child.type === 'interpolation') hasDynamicText = true;
      }
      const staticText = staticParts.join(' ').trim() || undefined;

      if (staticText) el.staticText = staticText;
      if (hasDynamicText) el.hasDynamicText = true;

      const controlType = controlTypeFor(el.el, el.attrs);
      if (controlType) el.controlType = controlType;
      const accessibleName = accessibleNameFor(el);
      if (accessibleName) el.accessibleName = accessibleName;
      if (el.attrs.role) el.role = el.attrs.role;
      if (isTruthyAttr(el.attrs.required)) el.required = true;
      if (el.el.includes('-')) el.sourceRepresentation = el.el;

      const stability = tokenStabilityFor(el, staticText);
      if (stability) el.tokenStability = stability;
      const template = stability === 'dynamic' ? tokenTemplateFor(el) : undefined;
      if (template) el.tokenTemplate = template;

      const candidates = selectorCandidatesFor(el, staticText);
      if (candidates.length) el.selectorCandidates = candidates;

      if (chain.length) {
        el.conditional = true;
        el.conditionChain = chain;
      }
      if (repeat.on) {
        el.repeated = true;
        if (repeat.over) el.repeatOver = repeat.over;
        if (repeat.varName) el.repeatVar = repeat.varName;
        if (repeat.trackBy) el.repeatTrackBy = repeat.trackBy;
      }

      seen.push(el);
      walk(el.children, chain, repeat);
    }
  };

  walk(nodes, [], { on: false });
  markUniqueness(seen);
  return seen;
}
