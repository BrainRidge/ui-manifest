import { describe, expect, it } from 'vitest';
import { collectRoutesFromSource } from '../src/route-parser.js';

describe('collectRoutesFromSource', () => {
  const src = `
    import { Routes } from '@angular/router';
    import { authGuard } from './auth.guard';

    export const routes: Routes = [
      { path: '', redirectTo: 'home', pathMatch: 'full' },
      { path: 'home', loadComponent: () => import('./home/home.component').then(m => m.HomeComponent) },
      {
        path: 'admin',
        loadComponent: () => import('./admin/admin.component').then((m) => m.AdminComponent),
        canActivate: [authGuard],
        canDeactivate: [authGuard],
        children: [
          { path: 'users', loadComponent: () => import('./admin/users.component').then(m => m.UsersComponent) },
        ],
      },
      { path: 'weird', loadComponent: someWeirdFactory() },
    ];
  `;

  it('resolves the loadComponent target via the import().then(m => m.X) shape', () => {
    const { routes } = collectRoutesFromSource(src, '/fake/app.routes.ts');
    const home = routes.find(r => r.path === 'home');
    expect(home?.component).toEqual({ module: './home/home.component', export: 'HomeComponent' });

    const admin = routes.find(r => r.path === 'admin');
    expect(admin?.component).toEqual({ module: './admin/admin.component', export: 'AdminComponent' });
  });

  it('extracts canActivate/canDeactivate guard arrays', () => {
    const { routes } = collectRoutesFromSource(src, '/fake/app.routes.ts');
    const admin = routes.find(r => r.path === 'admin');
    // A guard is an object now, not a name: a name cannot be opened, and "what gates this
    // route?" is only answerable to the point of usefulness with a file and a line.
    expect(admin?.guards?.canActivate).toEqual([
      { name: 'authGuard', kind: 'function', source: expect.objectContaining({ symbol: 'authGuard' }) },
    ]);
    expect(admin?.guards?.canDeactivate?.map(g => g.name)).toEqual(['authGuard']);

    const home = routes.find(r => r.path === 'home');
    expect(home?.guards).toBeUndefined();
  });

  it('extracts redirectTo/pathMatch on a plain redirect route', () => {
    const { routes } = collectRoutesFromSource(src, '/fake/app.routes.ts');
    expect(routes[0]).toMatchObject({ path: '', redirectTo: 'home', pathMatch: 'full' });
    expect(routes[0]?.source?.startLine).toBeGreaterThan(0);
  });

  it('recurses into children', () => {
    const { routes } = collectRoutesFromSource(src, '/fake/app.routes.ts');
    const admin = routes.find(r => r.path === 'admin');
    expect(admin?.children).toMatchObject([
      { path: 'users', component: { module: './admin/users.component', export: 'UsersComponent' } },
    ]);
  });

  it('leaves component unset and records a diagnostic when loadComponent does not match the expected shape', () => {
    const { routes, diagnostics } = collectRoutesFromSource(src, '/fake/app.routes.ts');
    const weird = routes.find(r => r.path === 'weird');
    expect(weird?.component).toBeUndefined();
    expect(diagnostics).toEqual(['unresolved loadComponent target: someWeirdFactory()']);
  });

  it('returns an empty route list when no `routes` array is found', () => {
    const result = collectRoutesFromSource(`export const somethingElse = [];`, '/fake/app.routes.ts');
    expect(result).toEqual({ routes: [], diagnostics: [] });
  });
});
