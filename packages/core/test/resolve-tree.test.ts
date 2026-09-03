import { describe, expect, it } from 'vitest';
import { resolveRouteDependencyTree } from '../src/resolve-tree.js';
import type { ComponentNode } from '../src/types/component.js';
import type { ElementNode, TextNode } from '../src/types/dom.js';

function el(tag: string, children: ElementNode['children'] = []): ElementNode {
  return { type: 'element', extraction: 'compiler', el: tag, attrs: {}, props: [], events: [], children };
}
function text(value: string): TextNode {
  return { type: 'text', extraction: 'compiler', value };
}

describe('resolveRouteDependencyTree', () => {
  it('splices a matched child component in place, annotated with provenance', () => {
    const componentB: ComponentNode = {
      className: 'BComponent',
      filePath: 'b.component.ts',
      inputs: [],
      outputs: [],
      dom: [el('span', [text('hi')])],
    };
    const componentA: ComponentNode = {
      className: 'AComponent',
      filePath: 'a.component.ts',
      inputs: [],
      outputs: [],
      dom: [el('div', [el('app-b')])],
    };
    const matchFn = (tag: string) => (tag === 'app-b' ? componentB : undefined);

    const result = resolveRouteDependencyTree('/a', componentA, matchFn);

    expect(result.rootComponent).toBe('AComponent');
    const div = result.tree[0];
    expect(div.type).toBe('element');
    if (div.type !== 'element') throw new Error('expected element');
    const boundary = div.children[0];
    expect(boundary).toMatchObject({
      type: 'component-boundary',
      tag: 'app-b',
      componentClassName: 'BComponent',
    });
    if (boundary.type !== 'component-boundary') throw new Error('expected component-boundary');
    expect(boundary.children[0]).toMatchObject({ type: 'element', el: 'span' });
  });

  it('expands the same component fresh in unrelated branches (no global visited-once cutoff)', () => {
    const shared: ComponentNode = {
      className: 'SharedComponent',
      filePath: 'shared.component.ts',
      inputs: [],
      outputs: [],
      dom: [el('p', [text('shared')])],
    };
    const root: ComponentNode = {
      className: 'RootComponent',
      filePath: 'root.component.ts',
      inputs: [],
      outputs: [],
      dom: [el('div', [el('app-shared'), el('app-shared')])],
    };
    const matchFn = (tag: string) => (tag === 'app-shared' ? shared : undefined);

    const result = resolveRouteDependencyTree('/root', root, matchFn);
    const div = result.tree[0];
    if (div.type !== 'element') throw new Error('expected element');
    expect(div.children).toHaveLength(2);
    expect(div.children[0].type).toBe('component-boundary');
    expect(div.children[1].type).toBe('component-boundary');
  });

  it('emits a cycle marker instead of recursing infinitely on self-inclusion', () => {
    const cyclic: ComponentNode = {
      className: 'CyclicComponent',
      filePath: 'cyclic.component.ts',
      inputs: [],
      outputs: [],
      dom: [], // filled in below, referencing itself
    };
    cyclic.dom = [el('div', [el('app-cyclic')])];
    const matchFn = (tag: string) => (tag === 'app-cyclic' ? cyclic : undefined);

    const result = resolveRouteDependencyTree('/cyclic', cyclic, matchFn);
    const div = result.tree[0];
    if (div.type !== 'element') throw new Error('expected element');
    const marker = div.children[0];
    expect(marker).toMatchObject({
      type: 'cycle-detected',
      tag: 'app-cyclic',
      componentClassName: 'CyclicComponent',
      cyclePath: ['CyclicComponent'],
    });
  });

  it('passes the CURRENT component (not always the root) to matchFn, so per-file resolution works two levels deep', () => {
    // Mirrors a real cross-file setup: matching "logo-tag" is only valid while resolving inside
    // BComponent's own template, not while still inside AComponent's. A matchFn that ignored its
    // second argument (or was pre-bound to a single component) could never tell these apart.
    const componentC: ComponentNode = {
      className: 'CComponent',
      filePath: 'c.component.ts',
      inputs: [],
      outputs: [],
      dom: [el('img')],
    };
    const componentB: ComponentNode = {
      className: 'BComponent',
      filePath: 'b.component.ts',
      inputs: [],
      outputs: [],
      dom: [el('logo-tag')],
    };
    const componentA: ComponentNode = {
      className: 'AComponent',
      filePath: 'a.component.ts',
      inputs: [],
      outputs: [],
      dom: [el('app-b')],
    };

    const seenContexts: string[] = [];
    const matchFn = (tag: string, current: ComponentNode) => {
      seenContexts.push(`${tag}@${current.className}`);
      if (tag === 'app-b' && current.className === 'AComponent') return componentB;
      if (tag === 'logo-tag' && current.className === 'BComponent') return componentC;
      return undefined; // e.g. 'logo-tag' resolved while current is still AComponent: not valid
    };

    const result = resolveRouteDependencyTree('/a', componentA, matchFn);

    const bBoundary = result.tree[0];
    expect(bBoundary).toMatchObject({ type: 'component-boundary', componentClassName: 'BComponent' });
    if (bBoundary.type !== 'component-boundary') throw new Error('expected component-boundary for B');
    const cBoundary = bBoundary.children[0];
    expect(cBoundary).toMatchObject({ type: 'component-boundary', componentClassName: 'CComponent' });

    // Every element node's tag is checked, including leaves with no match — 'img' (inside C's own
    // dom) is legitimately checked too, it just doesn't resolve to anything.
    expect(seenContexts).toEqual(['app-b@AComponent', 'logo-tag@BComponent', 'img@CComponent']);
  });

  it('detects indirect cycles (A -> B -> A), not just direct self-inclusion', () => {
    const a: ComponentNode = { className: 'A', filePath: 'a.ts', inputs: [], outputs: [], dom: [] };
    const b: ComponentNode = {
      className: 'B',
      filePath: 'b.ts',
      inputs: [],
      outputs: [],
      dom: [el('app-a')],
    };
    a.dom = [el('app-b')];
    const matchFn = (tag: string) => (tag === 'app-a' ? a : tag === 'app-b' ? b : undefined);

    const result = resolveRouteDependencyTree('/a', a, matchFn);
    const boundaryB = result.tree[0];
    if (boundaryB.type !== 'component-boundary') throw new Error('expected component-boundary for B');
    const marker = boundaryB.children[0];
    expect(marker).toMatchObject({ type: 'cycle-detected', componentClassName: 'A', cyclePath: ['A', 'B'] });
  });
});
