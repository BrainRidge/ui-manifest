/**
 * The shell above the router outlet composes with every route.
 *
 * Without this, a consumer keying elements by page attributes the navigation — the sign-out
 * button, the header, every global control — to no page at all, and answers "where is the
 * Logout button on the dashboard" with "the dashboard has none". A confident wrong answer,
 * which is worse than an absent one.
 */
import { describe, expect, it } from 'vitest';
import { extract } from '../src/index.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'route-trees-'));
  mkdirSync(join(dir, 'src', 'app'), { recursive: true });
  const write = (rel: string, text: string) => writeFileSync(join(dir, 'src', 'app', rel), text);

  write('app.routes.ts', `
    import { Routes } from '@angular/router';
    import { HomeComponent } from './home.component';
    export const routes: Routes = [{ path: 'home', component: HomeComponent }];
  `);
  // The shell: hosts the outlet, and renders the nav behind a guard the way a real app does.
  write('app.component.ts', `
    import { Component } from '@angular/core';
    @Component({
      selector: 'app-root',
      template: \`<div><app-nav *ngIf="signedIn"></app-nav><router-outlet></router-outlet></div>\`,
    })
    export class AppComponent { signedIn = true; }
  `);
  write('nav.component.ts', `
    import { Component } from '@angular/core';
    @Component({ selector: 'app-nav', template: \`<button class="logout">Logout</button>\` })
    export class NavComponent {}
  `);
  write('home.component.ts', `
    import { Component } from '@angular/core';
    @Component({ selector: 'app-home', template: \`<h1>Home</h1>\` })
    export class HomeComponent {}
  `);
  return dir;
}

describe('routeTrees', () => {
  it('names the shell chain above the outlet on every route', async () => {
    const manifest = await extract({ cwd: fixture(), withDom: true });
    const tree = (manifest.routeTrees ?? []).find(t => t.routePath === '/home');

    expect(tree?.rootComponent).toBe('HomeComponent');
    // The shell hosts the outlet, so it is a NODE rather than the root: the route's own
    // component is what the browser navigated to.
    const names = (tree?.nodes ?? []).flatMap(function names(n: any): string[] {
      return [n.component, ...(n.children ?? []).flatMap(names)];
    });
    expect(names).toContain('AppComponent');
    expect(names).toContain('NavComponent');
  });

  it('marks a shell rendered behind a guard as conditional', async () => {
    const manifest = await extract({ cwd: fixture(), withDom: true });
    const tree = (manifest.routeTrees ?? []).find(t => t.routePath === '/home');
    const nav = (tree?.nodes ?? [])
      .flatMap((n: any) => n.children ?? [])
      .find((n: any) => n.component === 'NavComponent');
    // `*ngIf="signedIn"` — a consumer must be able to tell "not on this page" from
    // "on this page only when signed in".
    expect(nav?.conditional).toBe(true);
  });

  it('records the route-trees pass so an absent tree is distinguishable from an unrun one', async () => {
    const withDom = await extract({ cwd: fixture(), withDom: true });
    const without = await extract({ cwd: fixture() });
    expect(withDom.provenance.generator.passes).toContain('route-trees');
    expect(without.provenance.generator.passes).not.toContain('route-trees');
    expect(without.routeTrees).toBeUndefined();
  });
});
