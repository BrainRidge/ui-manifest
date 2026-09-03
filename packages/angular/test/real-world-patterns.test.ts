import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extract } from '../src/index.js';

/**
 * Regression coverage for three real-world Angular Router shapes found by running this extractor
 * against an actual cloned open-source app (gothinkster/angular-realworld-example-app) before
 * publishing — the original prototype (and this port, initially) only handled
 * `loadComponent: () => import('./x').then(m => m.X)`, which turned out to miss most of a real
 * app's routes entirely.
 */
describe('real-world Angular Router patterns', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-manifest-angular-realworld-'));
    mkdirSync(join(dir, 'src/app/home'), { recursive: true });
    mkdirSync(join(dir, 'src/app/settings'), { recursive: true });
    mkdirSync(join(dir, 'src/app/profile'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the modern default-export loadComponent form (no .then()) by matching the target file', async () => {
    writeFileSync(
      join(dir, 'src/app/app.routes.ts'),
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          { path: '', loadComponent: () => import('./home/home.component') },
        ];
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/app/home/home.component.ts'),
      `
        import { Component } from '@angular/core';
        @Component({ selector: 'app-home-page', template: '<div>home</div>' })
        export default class HomeComponent {}
      `,
      'utf8',
    );

    const manifest = await extract({ cwd: dir });
    expect(manifest.routes).toEqual([{ path: '', component: { module: './home/home.component', export: 'HomeComponent' } }]);
    expect(manifest.diagnostics ?? []).toEqual([]);
  });

  it('resolves an eager `component: X` route target (no dynamic import at all)', async () => {
    writeFileSync(
      join(dir, 'src/app/app.routes.ts'),
      `
        import { Routes } from '@angular/router';
        import { SettingsComponent } from './settings/settings.component';
        export const routes: Routes = [
          { path: 'settings', component: SettingsComponent },
        ];
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/app/settings/settings.component.ts'),
      `
        import { Component } from '@angular/core';
        @Component({ selector: 'app-settings-page', template: '<div>settings</div>' })
        export class SettingsComponent {}
      `,
      'utf8',
    );

    const manifest = await extract({ cwd: dir });
    expect(manifest.routes).toEqual([
      { path: 'settings', component: { module: 'src/app/settings/settings.component.ts', export: 'SettingsComponent' } },
    ]);
  });

  it('recurses into a loadChildren target file, including its `export default routes;` shape', async () => {
    writeFileSync(
      join(dir, 'src/app/app.routes.ts'),
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          { path: 'profile', loadChildren: () => import('./profile/profile.routes') },
        ];
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/app/profile/profile.routes.ts'),
      `
        import { Routes } from '@angular/router';
        const routes: Routes = [
          { path: ':username', loadComponent: () => import('./profile.component').then(m => m.ProfileComponent) },
        ];
        export default routes;
      `,
      'utf8',
    );
    writeFileSync(join(dir, 'src/app/profile/profile.component.ts'), `export class ProfileComponent {}`, 'utf8');

    const manifest = await extract({ cwd: dir });
    expect(manifest.routes).toEqual([
      {
        path: 'profile',
        children: [{ path: ':username', component: { module: './profile.component', export: 'ProfileComponent' } }],
      },
    ]);
    expect(manifest.diagnostics ?? []).toEqual([]);
  });

  it('detects a loadChildren cycle instead of recursing infinitely', async () => {
    writeFileSync(
      join(dir, 'src/app/app.routes.ts'),
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          { path: 'a', loadChildren: () => import('./a.routes') },
        ];
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/app/a.routes.ts'),
      `
        import { Routes } from '@angular/router';
        export const routes: Routes = [
          { path: 'b', loadChildren: () => import('./a.routes') },
        ];
      `,
      'utf8',
    );

    const manifest = await extract({ cwd: dir });
    expect(manifest.diagnostics).toContain('loadChildren cycle detected, not expanding further: ./a.routes (from src/app/a.routes.ts)');
  });
});
