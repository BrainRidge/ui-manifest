import { describe, expect, it } from 'vitest';
import { parseComponentDom, switchGroups } from '../src/dom-parser.js';

async function domOf(template: string) {
  const result = await parseComponentDom(template, 'test.html');
  if (!result.ok) throw new Error(`expected a successful parse, got error: ${result.error}`);
  return result.dom;
}

describe('parseComponentDom', () => {
  it('parses a legacy *ngIf structural directive as a template node wrapping the element', async () => {
    const dom = await domOf(`<div *ngIf="visible">Hello</div>`);
    expect(dom).toMatchObject([
      {
        type: 'template',
        extraction: 'compiler',
        structural: '*ngIf',
        condition: 'visible',
        children: [
          {
            type: 'element',
            extraction: 'compiler',
            el: 'div',
            attrs: {},
            props: [],
            events: [],
            children: [{ type: 'text', extraction: 'compiler', value: 'Hello' }],
          },
        ],
      },
    ]);
  });

  it('parses a legacy *ngFor structural directive, exposing the iterable as condition', async () => {
    const dom = await domOf(`<li *ngFor="let item of items">{{item.name}}</li>`);
    expect(dom[0]).toMatchObject({ type: 'template', structural: '*ngFor', condition: 'items' });
    expect((dom[0] as { children: unknown[] }).children[0]).toMatchObject({ type: 'element', el: 'li' });
  });

  it('parses @if/@else as a template node with per-branch conditions, primary branch mirrored into children', async () => {
    const dom = await domOf(`@if (visible) {<span>Yes</span>} @else {<span>No</span>}`);
    expect(dom).toMatchObject([
      {
        type: 'template',
        extraction: 'compiler',
        structural: '@if',
        condition: 'visible',
        branches: [
          {
            label: 'if',
            condition: 'visible',
            children: [
              {
                type: 'element',
                extraction: 'compiler',
                el: 'span',
                attrs: {},
                props: [],
                events: [],
                children: [{ type: 'text', extraction: 'compiler', value: 'Yes' }],
              },
            ],
          },
          {
            label: 'else',
            children: [
              {
                type: 'element',
                extraction: 'compiler',
                el: 'span',
                attrs: {},
                props: [],
                events: [],
                children: [{ type: 'text', extraction: 'compiler', value: 'No' }],
              },
            ],
          },
        ],
        children: [
          {
            type: 'element',
            extraction: 'compiler',
            el: 'span',
            attrs: {},
            props: [],
            events: [],
            children: [{ type: 'text', extraction: 'compiler', value: 'Yes' }],
          },
        ],
      },
    ]);
  });

  it('parses @for/@empty, folding item/of/track into condition and empty into a branch', async () => {
    const dom = await domOf(
      `@for (item of items; track item.id) {<li>{{item.name}}</li>} @empty {<li>none</li>}`,
    );
    expect(dom[0]).toMatchObject({
      type: 'template',
      structural: '@for',
      condition: 'item of items; track item.id',
      branches: [{ label: 'empty' }],
    });
  });

  it('parses @switch/@case/@default, each case its own branch with the primary branch mirrored into children', async () => {
    const dom = await domOf(
      `@switch (status) {@case ('a') {<p>A</p>} @case ('b') {<p>B</p>} @default {<p>Other</p>}}`,
    );
    expect(dom[0]).toMatchObject({
      type: 'template',
      structural: '@switch',
      condition: 'status',
      branches: [
        { label: "'a'", condition: "'a'" },
        { label: "'b'", condition: "'b'" },
        { label: 'default' },
      ],
    });
    expect((dom[0] as { branches: { label: string }[] }).branches[2]).not.toHaveProperty('condition');
  });

  it('parses @defer with @placeholder/@loading/@error as branches and triggers folded into condition', async () => {
    const dom = await domOf(
      `@defer (on viewport) {<div>content</div>} @placeholder {<div>ph</div>} @loading {<div>loading</div>} @error {<div>err</div>}`,
    );
    expect(dom[0]).toMatchObject({
      type: 'template',
      structural: '@defer',
      condition: 'viewport',
      branches: [{ label: 'placeholder' }, { label: 'loading' }, { label: 'error' }],
    });
  });

  it('maps <ng-content select="..."> to an element node with a select attr', async () => {
    const dom = await domOf(`<ng-content select="[foo]"></ng-content>`);
    expect(dom).toMatchObject([
      { type: 'element', extraction: 'compiler', el: 'ng-content', attrs: { select: '[foo]' }, props: [], events: [], children: [] },
    ]);
  });

  it('captures bound props, events, and template refs on a plain element', async () => {
    const dom = await domOf(`<input [value]="name" (input)="onInput($event)" #ref />`);
    expect(dom[0]).toMatchObject({
      type: 'element',
      el: 'input',
      props: [{ name: 'value', expr: 'name' }],
      events: [{ name: 'input', expr: 'onInput($event)' }],
      refs: ['ref'],
    });
  });

  it('returns ok:false with a joined error message on a malformed template', async () => {
    const result = await parseComponentDom(`<div [(broken>`, 'test.html');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe('@switch across Angular compiler versions', () => {
  /**
   * Angular 22 renamed `SwitchBlock.cases` to `.groups` and changed its element type. This package
   * declares `@angular/compiler: ">=17.0.0"`, and reading only the new shape threw
   * `Cannot read properties of undefined (reading 'map')` on EVERY `@switch` block for anyone on
   * 17-21 — invisible in this repo, whose own devDependency is 22.x.
   *
   * The live parse below covers whichever version is installed; the two shape tests cover the other
   * one, since only one @angular/compiler can be installed at a time.
   */
  it('parses a real @switch with whatever compiler is installed', async () => {
    const dom = await domOf(
      `@switch (state) { @case ('a') { <p>A</p> } @case ('b') { <p>B</p> } @default { <p>D</p> } }`,
    );
    const node = dom.find(n => n.type === 'template');
    if (node?.type !== 'template') throw new Error('expected a @switch template node');
    expect(node.structural).toBe('@switch');
    expect(node.condition).toBe('state');
    expect(node.branches?.map(b => b.label)).toEqual(["'a'", "'b'", 'default']);
  });

  it('normalises the pre-22 `cases` shape, where each case carries its own children', () => {
    const legacy = {
      expression: { toString: () => 'state' },
      cases: [
        { expression: { value: 'a' }, children: [] },
        { expression: null, children: [] },
      ],
    };
    const groups = switchGroups(legacy as never);
    expect(groups).toHaveLength(2);
    expect(groups[0].cases).toHaveLength(1);
    expect(groups[1].cases[0].expression).toBeNull();   // the @default branch
  });

  it('passes the 22+ `groups` shape through, keeping fall-through cases together', () => {
    // `@case (a) @case (b) { ... }` — several cases, one body. The 22 model is strictly richer, so
    // it is the one both are normalised onto.
    const modern = {
      expression: { toString: () => 'state' },
      groups: [{ cases: [{ expression: { value: 'a' } }, { expression: { value: 'b' } }], children: [] }],
    };
    const groups = switchGroups(modern as never);
    expect(groups).toHaveLength(1);
    expect(groups[0].cases).toHaveLength(2);
  });
});

describe('<ng-content> across Angular compiler versions', () => {
  /**
   * `TmplAstContent` gained `children` after Angular 17 — before that `<ng-content>` was
   * self-closing by construction and the class had no such property. Reading it threw on every
   * template containing an `<ng-content>`, which is most component libraries.
   *
   * Same family as the `@switch` drift, found the same way: installing the packed tarball against
   * each version in the declared `>=17.0.0` peer range rather than trusting the monorepo's own
   * hoisted 22.x devDependency.
   */
  it('parses <ng-content> with whatever compiler is installed', async () => {
    // The bare `<div>` around it is a presentational wrapper and is collapsed away by the
    // semantic node policy, so the ng-content is spliced up into its place.
    const dom = await domOf(`<div><ng-content select="[header]"></ng-content></div>`);
    const content = dom[0];
    if (content?.type !== 'element') throw new Error('expected an ng-content element');
    expect(content.el).toBe('ng-content');
    expect(content.attrs).toEqual({ select: '[header]' });
    expect(Array.isArray(content.children)).toBe(true);
  });

  it('treats a childless <ng-content> as empty, not as a crash', async () => {
    // On Angular 17 EVERY ng-content takes this path, because the property does not exist there.
    const dom = await domOf(`<ng-content></ng-content>`);
    const content = dom[0];
    if (content?.type !== 'element') throw new Error('expected an ng-content element');
    expect(content.children).toEqual([]);
  });
});
