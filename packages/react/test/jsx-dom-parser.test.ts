import { describe, expect, it } from 'vitest';
import type { DomNode, ElementNode, InterpolationNode, TemplateNode } from '@ui-manifest/core';
import { detectComponents } from '../src/component-detector.js';
import { buildDom } from '../src/jsx-dom-parser.js';
import { createSourceFile } from './helpers.js';

function domFor(src: string): DomNode[] {
  const sf = createSourceFile(src);
  const { components } = detectComponents(sf);
  if (!components[0]) throw new Error('expected at least one detected component in fixture');
  return buildDom(components[0].primaryJsx, sf);
}

describe('buildDom (JSX -> DomNode)', () => {
  it('captures static attrs, boolean shorthand, bound props, and on* events separately', () => {
    const dom = domFor(`
      export const Widget = (props: { count: number }) => {
        return <button className="primary" disabled onClick={() => doThing()} data-count={props.count}>Go</button>;
      };
    `);
    expect(dom).toHaveLength(1);
    const el = dom[0] as ElementNode;
    expect(el.type).toBe('element');
    expect(el.extraction).toBe('compiler');
    expect(el.el).toBe('button');
    expect(el.attrs).toEqual({ className: 'primary', disabled: 'true' });
    expect(el.events).toEqual([{ name: 'onClick', expr: '() => doThing()' }]);
    expect(el.props).toEqual([{ name: 'data-count', expr: 'props.count' }]);
    expect(el.children).toEqual([{ type: 'text', extraction: 'compiler', value: 'Go' }]);
  });

  it('records a spread attribute as a synthetic "...spread" props entry', () => {
    const dom = domFor(`
      export const Widget = (props: any) => {
        return <input {...props} />;
      };
    `);
    const el = dom[0] as ElementNode;
    expect(el.props).toEqual([{ name: '...spread', expr: 'props' }]);
  });

  it('recurses into nested elements and skips whitespace-only text between them', () => {
    const dom = domFor(`
      export const Widget = () => {
        return (
          <div>
            <span>Hi</span>
          </div>
        );
      };
    `);
    const outer = dom[0] as ElementNode;
    expect(outer.el).toBe('div');
    expect(outer.children).toHaveLength(1);
    const inner = outer.children[0] as ElementNode;
    expect(inner.el).toBe('span');
    expect(inner.extraction).toBe('compiler');
    expect(inner.children).toEqual([{ type: 'text', extraction: 'compiler', value: 'Hi' }]);
  });

  it('captures an unrecognized {expr} child as a compiler-extracted interpolation with raw source', () => {
    const dom = domFor(`
      export const Widget = (props: { count: number }) => {
        return <div>{props.count + 1}</div>;
      };
    `);
    const child = (dom[0] as ElementNode).children[0] as InterpolationNode;
    expect(child).toEqual({ type: 'interpolation', extraction: 'compiler', interpolation: 'props.count + 1' });
  });

  it('splices a top-level fragment\'s children directly, with no synthetic wrapper node', () => {
    const dom = domFor(`
      export const Widget = () => {
        return <><span>A</span><span>B</span></>;
      };
    `);
    expect(dom).toHaveLength(2);
    expect((dom[0] as ElementNode).el).toBe('span');
    expect((dom[1] as ElementNode).el).toBe('span');
  });

  it('splices a nested fragment child directly into its parent\'s children', () => {
    const dom = domFor(`
      export const Widget = () => {
        return <div><><span>A</span><span>B</span></></div>;
      };
    `);
    const outer = dom[0] as ElementNode;
    expect(outer.children).toHaveLength(2);
    expect((outer.children[0] as ElementNode).el).toBe('span');
  });

  it('detects a ternary with two JSX branches as a heuristic template, duplicating the consequent into `children`', () => {
    const dom = domFor(`
      export const Widget = (props: { loggedIn: boolean }) => {
        return <div>{props.loggedIn ? <Avatar /> : <LoginButton />}</div>;
      };
    `);
    const template = (dom[0] as ElementNode).children[0] as TemplateNode;
    expect(template.type).toBe('template');
    expect(template.structural).toBe('ternary');
    expect(template.extraction).toBe('heuristic');
    expect(template.condition).toBe('props.loggedIn');
    expect(template.branches).toHaveLength(2);
    expect(template.branches![0].label).toBe('consequent');
    expect((template.branches![0].children[0] as ElementNode).el).toBe('Avatar');
    expect(template.branches![1].label).toBe('alternate');
    expect((template.branches![1].children[0] as ElementNode).el).toBe('LoginButton');
    expect(template.children).toEqual(template.branches![0].children);
  });

  it('treats a ternary\'s `: null` alternate branch as empty children', () => {
    const dom = domFor(`
      export const Widget = (props: { show: boolean }) => {
        return <div>{props.show ? <Banner /> : null}</div>;
      };
    `);
    const template = (dom[0] as ElementNode).children[0] as TemplateNode;
    expect(template.branches![1].children).toEqual([]);
  });

  it('detects && short-circuit as a single-branch heuristic template (no `branches`)', () => {
    const dom = domFor(`
      export const Widget = (props: { error: string }) => {
        return <div>{props.error && <ErrorBanner message={props.error} />}</div>;
      };
    `);
    const template = (dom[0] as ElementNode).children[0] as TemplateNode;
    expect(template.type).toBe('template');
    expect(template.structural).toBe('&&');
    expect(template.extraction).toBe('heuristic');
    expect(template.condition).toBe('props.error');
    expect(template.branches).toBeUndefined();
    expect((template.children[0] as ElementNode).el).toBe('ErrorBanner');
  });

  it('detects .map() returning JSX as a heuristic template captured once, not unrolled per item', () => {
    const dom = domFor(`
      export const Widget = (props: { items: string[] }) => {
        return <ul>{props.items.map((item) => <li key={item}>{item}</li>)}</ul>;
      };
    `);
    const template = (dom[0] as ElementNode).children[0] as TemplateNode;
    expect(template.type).toBe('template');
    expect(template.structural).toBe('.map()');
    expect(template.extraction).toBe('heuristic');
    expect(template.condition).toBe('props.items');
    expect(template.children).toHaveLength(1);
    const li = template.children[0] as ElementNode;
    expect(li.el).toBe('li');
    // `key` is just a normal bound prop, nothing special.
    expect(li.props).toEqual([{ name: 'key', expr: 'item' }]);
  });

  it('resolves a .map() callback with a block body via its return statement', () => {
    const dom = domFor(`
      export const Widget = (props: { items: string[] }) => {
        return <ul>{props.items.map((item) => { return <li key={item}>{item}</li>; })}</ul>;
      };
    `);
    const template = (dom[0] as ElementNode).children[0] as TemplateNode;
    expect(template.structural).toBe('.map()');
    expect((template.children[0] as ElementNode).el).toBe('li');
  });

  it('marks every non-heuristic node "compiler" and every control-flow node "heuristic" in one mixed tree', () => {
    const dom = domFor(`
      export const Widget = (props: { items: string[]; error?: string }) => {
        return (
          <div className="root">
            <p>{props.error && <span>{props.error}</span>}</p>
            <ul>{props.items.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        );
      };
    `);
    const root = dom[0] as ElementNode;
    expect(root.extraction).toBe('compiler');
    const p = root.children[0] as ElementNode;
    expect(p.extraction).toBe('compiler');
    const andTemplate = p.children[0] as TemplateNode;
    expect(andTemplate.extraction).toBe('heuristic');
    const ul = root.children[1] as ElementNode;
    const mapTemplate = ul.children[0] as TemplateNode;
    expect(mapTemplate.extraction).toBe('heuristic');
  });
});
