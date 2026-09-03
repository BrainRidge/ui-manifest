import type { ComponentNode, ElementNode, RouteNode, TextNode } from '@ui-manifest-json/core';
import { describe, expect, it } from 'vitest';
import { buildDependencyGraph } from '../src/resolve.js';

function el(tag: string, children: ElementNode['children'] = []): ElementNode {
  return { type: 'element', extraction: 'compiler', el: tag, attrs: {}, props: [], events: [], children };
}
function text(value: string): TextNode {
  return { type: 'text', extraction: 'compiler', value };
}

describe('buildDependencyGraph', () => {
  it('splices a matched child component in place, matching by comma-split selector and skipping attribute selectors', () => {
    const tabComponent: ComponentNode = {
      className: 'TabComponent',
      filePath: 'tab.component.ts',
      selector: 'app-tab, [appTab]',
      inputs: [],
      outputs: [],
      dom: [el('span', [text('tab')])],
    };
    const rootComponent: ComponentNode = {
      className: 'RootComponent',
      filePath: 'root.component.ts',
      selector: 'app-root',
      inputs: [],
      outputs: [],
      dom: [el('div', [el('app-tab'), el('span', [text('x')])])],
    };
    const routes: RouteNode[] = [{ path: 'root', component: { module: 'x', export: 'RootComponent' } }];

    const { dependencyGraph, diagnostics } = buildDependencyGraph(routes, [tabComponent, rootComponent]);

    expect(diagnostics).toEqual([]);
    expect(dependencyGraph).toHaveLength(1);
    expect(dependencyGraph[0].routePath).toBe('root');
    expect(dependencyGraph[0].rootComponent).toBe('RootComponent');

    const div = dependencyGraph[0].tree[0];
    if (div.type !== 'element') throw new Error('expected element');
    const [boundary, plainSpan] = div.children;
    expect(boundary).toMatchObject({ type: 'component-boundary', tag: 'app-tab', componentClassName: 'TabComponent' });
    expect(plainSpan).toMatchObject({ type: 'element', el: 'span' });
  });

  it('emits a cycle-detected marker instead of recursing on self-inclusion', () => {
    const selfComponent: ComponentNode = {
      className: 'SelfComponent',
      filePath: 'self.component.ts',
      selector: 'app-self',
      inputs: [],
      outputs: [],
      dom: [],
    };
    selfComponent.dom = [el('div', [el('app-self')])];
    const routes: RouteNode[] = [{ path: 'self', component: { module: 'x', export: 'SelfComponent' } }];

    const { dependencyGraph } = buildDependencyGraph(routes, [selfComponent]);
    const div = dependencyGraph[0].tree[0];
    if (div.type !== 'element') throw new Error('expected element');
    expect(div.children[0]).toMatchObject({
      type: 'cycle-detected',
      tag: 'app-self',
      componentClassName: 'SelfComponent',
      cyclePath: ['SelfComponent'],
    });
  });

  it('records a diagnostic and skips a route whose loadComponent export has no matching component', () => {
    const routes: RouteNode[] = [{ path: 'missing', component: { module: 'x', export: 'NoSuchComponent' } }];
    const { dependencyGraph, diagnostics } = buildDependencyGraph(routes, []);
    expect(dependencyGraph).toEqual([]);
    expect(diagnostics).toEqual(['dependency graph: no component found for route "missing" (export "NoSuchComponent")']);
  });

  it('walks nested route children, resolving each one that has a component target', () => {
    const leaf: ComponentNode = { className: 'LeafComponent', filePath: 'leaf.ts', inputs: [], outputs: [], dom: [] };
    const routes: RouteNode[] = [
      {
        path: 'parent',
        children: [{ path: 'child', component: { module: 'x', export: 'LeafComponent' } }],
      },
    ];
    const { dependencyGraph } = buildDependencyGraph(routes, [leaf]);
    expect(dependencyGraph).toHaveLength(1);
    expect(dependencyGraph[0].routePath).toBe('child');
  });

  it('skips components with no selector when building the tag map', () => {
    const noSelector: ComponentNode = { className: 'Anon', filePath: 'anon.ts', inputs: [], outputs: [], dom: [] };
    const root: ComponentNode = {
      className: 'RootComponent',
      filePath: 'root.ts',
      selector: 'app-root',
      inputs: [],
      outputs: [],
      dom: [el('app-unmatched')],
    };
    const routes: RouteNode[] = [{ path: 'root', component: { module: 'x', export: 'RootComponent' } }];
    const { dependencyGraph } = buildDependencyGraph(routes, [noSelector, root]);
    // app-unmatched matches nothing (no component with that selector) so it stays a plain element.
    expect(dependencyGraph[0].tree[0]).toMatchObject({ type: 'element', el: 'app-unmatched' });
  });
});
