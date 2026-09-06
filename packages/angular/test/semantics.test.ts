/**
 * What v0.3.0 adds, asserted at the level a consumer actually reads.
 *
 * Every case here is one that a consumer previously had to reconstruct from the tree — and would
 * have got wrong, because the information needed to do it correctly was not in the file. The
 * login-form fixture is deliberately the shape of a real one: two named inputs, a submit button
 * whose only handle is its caption, and an error message behind an `*ngIf`.
 */
import { describe, expect, it } from 'vitest';
import { parseComponentDom } from '../src/dom-parser.js';
import type { DomNode, ElementNode } from '@ui-manifest-json/core';

async function domOf(template: string, origin = { path: 'src/app/login.component.html', lineOffset: 0 }) {
  const result = await parseComponentDom(template, origin.path, origin);
  if (!result.ok) throw new Error(result.error);
  return result.dom;
}

/** Every element in the tree, depth-first — the same walk a consumer does. */
function elements(nodes: DomNode[]): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (list: DomNode[]) => {
    for (const node of list) {
      if (node.type === 'element') out.push(node);
      if (node.type === 'element' || node.type === 'template') walk(node.children);
      // `branches[0]` IS `children` for an @if/@switch — walking both would visit the primary
      // branch twice, which is exactly the mistake the enrichment pass avoids with `.slice(1)`.
      if (node.type === 'template') for (const b of (node.branches ?? []).slice(1)) walk(b.children);
    }
  };
  walk(nodes);
  return out;
}

const LOGIN_FORM = `<form (ngSubmit)="onSubmit()" class="login-form">
  <label for="username">Username</label>
  <input type="text" id="username" [(ngModel)]="username" name="username" required />
  <div class="error-message" *ngIf="errorMessage">{{ errorMessage }}</div>
  <button type="submit" class="login-button">Sign In</button>
</form>`;

describe('source pointers', () => {
  it('gives every element a 1-based line in the file its text lives in', async () => {
    const dom = await domOf(LOGIN_FORM);
    const button = elements(dom).find(e => e.el === 'button');
    // The button is on the 5th line of the template, and editors count from 1.
    expect(button?.source).toMatchObject({ path: 'src/app/login.component.html', startLine: 5 });
  });

  it('offsets an inline template by where its literal opens', async () => {
    // The same template, but living at line 14 of a .component.ts. Without the offset every
    // pointer here lands in the import block — confidently wrong rather than merely absent.
    const dom = await domOf(LOGIN_FORM, { path: 'src/app/login.component.ts', lineOffset: 13 });
    const button = elements(dom).find(e => e.el === 'button');
    expect(button?.source).toMatchObject({ path: 'src/app/login.component.ts', startLine: 18 });
  });
});

describe('static text folding', () => {
  it('folds a button caption onto the button, which is its only handle', async () => {
    const dom = await domOf(LOGIN_FORM);
    const button = elements(dom).find(e => e.el === 'button');
    // No id, no name, no testid — exactly the shape of most submit buttons. Without the caption
    // folded up, this element cannot be addressed at all.
    expect(button?.staticText).toBe('Sign In');
    expect(button?.tokenStability).toBe('static');
    expect(button?.controlType).toBe('button');
  });

  it('never folds an interpolation, and says that it saw one', async () => {
    const dom = await domOf(LOGIN_FORM);
    const error = elements(dom).find(e => e.attrs.class === 'error-message');
    // A key built from `{{ errorMessage }}` changes with the test data.
    expect(error?.staticText).toBeUndefined();
    expect(error?.hasDynamicText).toBe(true);
  });
});

describe('denormalized ancestry', () => {
  it('copies the *ngIf that gates an element onto the element itself', async () => {
    const dom = await domOf(LOGIN_FORM);
    const error = elements(dom).find(e => e.attrs.class === 'error-message');
    // This is what turns "why is this field not on the page?" from a repository search into a
    // field read.
    expect(error?.conditional).toBe(true);
    expect(error?.conditionChain).toMatchObject([{ directive: '*ngIf', expr: 'errorMessage' }]);
  });

  it('leaves an unconditional element unmarked rather than marked false', async () => {
    const dom = await domOf(LOGIN_FORM);
    const input = elements(dom).find(e => e.el === 'input');
    expect(input?.conditional).toBeUndefined();
  });

  it('records which branch of an @if/@else an element sits in', async () => {
    const dom = await domOf(`@if (ok) {<span id="yes">Y</span>} @else {<span id="no">N</span>}`);
    const no = elements(dom).find(e => e.attrs.id === 'no');
    expect(no?.conditionChain).toMatchObject([{ directive: '@if', branch: 'else' }]);
  });

  it('does not double-count the primary branch, which is both `children` and `branches[0]`', async () => {
    const dom = await domOf(`@if (ok) {<span id="yes">Y</span>}`);
    const yes = elements(dom).filter(e => e.attrs.id === 'yes');
    expect(yes).toHaveLength(1);
    expect(yes[0]?.conditionChain).toHaveLength(1);
  });

  it('marks a repeated element with what it repeats over', async () => {
    const dom = await domOf(`@for (tx of transactions; track tx.id) {<td id="amt">{{tx.amount}}</td>}`);
    const cell = elements(dom).find(e => e.el === 'td');
    expect(cell).toMatchObject({ repeated: true, repeatOver: 'transactions', repeatVar: 'tx' });
  });
});

describe('handles', () => {
  it('enumerates every handle the source offers, scoped honestly', async () => {
    const dom = await domOf(LOGIN_FORM);
    const input = elements(dom).find(e => e.el === 'input');
    expect(input?.selectorCandidates).toMatchObject([
      { by: 'id', value: '#username', unique: true, uniqueScope: 'template' },
      { by: 'name', value: 'input[name="username"]', unique: true, uniqueScope: 'template' },
    ]);
  });

  it('reports a control with no stable handle, which is the actionable finding', async () => {
    const dom = await domOf(`<div class="wrapper"><button class="icon-only" (click)="go()"></button></div>`);
    const button = elements(dom).find(e => e.el === 'button');
    // No id, no name, no testid, no caption. Reported with a file and a line this reads
    // "add a data-testid here"; unreported it is simply missing from every join.
    expect(button?.tokenStability).toBe('none');
    expect(button?.source?.startLine).toBe(1);
  });

  it('marks a token assembled from an expression, with its literal prefix', async () => {
    const dom = await domOf(`<tr [attr.id]="'tx-' + tx.id"><td>x</td></tr>`);
    const row = elements(dom).find(e => e.el === 'tr');
    expect(row?.tokenStability).toBe('dynamic');
    expect(row?.tokenTemplate).toBe('tx-{{*}}');
  });

  it('does not claim uniqueness for a handle that repeats in the template', async () => {
    const dom = await domOf(`<div><button>Save</button><button>Save</button></div>`);
    const [first] = elements(dom).filter(e => e.el === 'button');
    expect(first?.selectorCandidates?.find(c => c.by === 'text')?.unique).toBe(false);
  });
});

describe('two-way bindings', () => {
  it('marks ngModel\'s generated write-back so it is not counted as a handler', async () => {
    const dom = await domOf(LOGIN_FORM);
    const input = elements(dom).find(e => e.el === 'input');
    // `[(ngModel)]` desugars into a property AND an event. Counted as a handler, every two-way
    // bound field looks interactive twice.
    // The emitted name is the template's own spelling (`ngModel`, from the keySpan) — Angular
    // calls the generated output `ngModelChange` internally. `kind` is what tells the two apart,
    // which is the reason it exists.
    expect(input?.events).toMatchObject([{ name: 'ngModel', kind: 'twoWayWriteback' }]);
    expect(input?.props).toMatchObject([{ name: 'ngModel', kind: 'twoWay' }]);
  });

  it('leaves a real handler marked as one', async () => {
    const dom = await domOf(LOGIN_FORM);
    const form = elements(dom).find(e => e.el === 'form');
    expect(form?.events).toMatchObject([{ name: 'ngSubmit', expr: 'onSubmit()', kind: 'output' }]);
  });
});
