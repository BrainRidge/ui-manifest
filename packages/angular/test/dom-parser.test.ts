import { describe, expect, it } from 'vitest';
import { parseComponentDom } from '../src/dom-parser.js';

async function domOf(template: string) {
  const result = await parseComponentDom(template, 'test.html');
  if (!result.ok) throw new Error(`expected a successful parse, got error: ${result.error}`);
  return result.dom;
}

describe('parseComponentDom', () => {
  it('parses a legacy *ngIf structural directive as a template node wrapping the element', async () => {
    const dom = await domOf(`<div *ngIf="visible">Hello</div>`);
    expect(dom).toEqual([
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
    expect(dom).toEqual([
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
    expect(dom).toEqual([
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
