import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@ui-manifest-json/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extract } from '../src/index.js';

describe('extract', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-manifest-angular-extract-'));
    mkdirSync(join(dir, 'src/app/root'), { recursive: true });
    mkdirSync(join(dir, 'src/app/child'), { recursive: true });

    writeFileSync(
      join(dir, 'src/app/app.routes.ts'),
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          { path: '', loadComponent: () => import('./root/root.component').then(m => m.RootComponent) },
        ];
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/app/root/root.component.ts'),
      `
        import { Component, Input } from '@angular/core';
        @Component({ selector: 'app-root', template: '<div><app-child></app-child></div>' })
        export class RootComponent {
          @Input() title: string;
        }
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/app/child/child.component.ts'),
      `
        import { Component } from '@angular/core';
        @Component({ selector: 'app-child', template: '<span>child</span>' })
        export class ChildComponent {}
      `,
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a schema-conformant manifest with routes and components, dom/dependencyGraph absent by default', async () => {
    const manifest = await extract({ cwd: dir });

    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.framework).toBe('angular');
    expect(typeof manifest.generatedAt).toBe('string');
    expect(() => new Date(manifest.generatedAt).toISOString()).not.toThrow();

    expect(manifest.routes).toEqual([
      { path: '', fullPath: '/', component: { module: './root/root.component', export: 'RootComponent' } },
    ]);
    expect(manifest.components.map(c => c.className).sort()).toEqual(['ChildComponent', 'RootComponent']);
    expect(manifest.components.every(c => c.dom === undefined)).toBe(true);
    expect(manifest.dependencyGraph).toBeUndefined();
  });

  it('attaches dom trees with --with-dom and a resolved dependencyGraph with --dependency-graph', async () => {
    const manifest = await extract({ cwd: dir, withDom: true, dependencyGraph: true });

    const root = manifest.components.find(c => c.className === 'RootComponent');
    expect(root?.dom).toBeDefined();

    expect(manifest.dependencyGraph).toHaveLength(1);
    const tree = manifest.dependencyGraph![0];
    expect(tree.routePath).toBe('');
    expect(tree.rootComponent).toBe('RootComponent');
    const div = tree.tree[0];
    if (div.type !== 'element') throw new Error('expected element');
    expect(div.children[0]).toMatchObject({
      type: 'component-boundary',
      tag: 'app-child',
      componentClassName: 'ChildComponent',
    });
  });

  it('rejects --dependency-graph without --with-dom', async () => {
    await expect(extract({ cwd: dir, dependencyGraph: true })).rejects.toThrow('--dependency-graph requires --with-dom');
  });
});
