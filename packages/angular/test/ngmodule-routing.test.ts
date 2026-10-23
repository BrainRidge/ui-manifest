import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extract } from '../src/index.js';
import type { RouteNode } from '@ui-manifest-json/core';

/**
 * Regression coverage for NgModule-based apps — the layout `ng generate module --routing` emits,
 * which is still what most pre-standalone Angular apps are written in.
 *
 * Reported against 0.4.0 by a 18.2 app whose `app-routing.module.ts` lazy-loads 7 feature
 * NgModules: every one warned "loadChildren target has no routes array" and the manifest came back
 * with only the top-level routes. The cause was that the extractor looked for routes IN the
 * `loadChildren` target, where this layout never puts them — the feature module holds no routes
 * array, it imports a sibling `*-routing.module.ts` that calls `RouterModule.forChild(routes)`.
 * Components and their DOM were captured all along, so the gap was precisely the route-to-
 * component mapping, i.e. the page map.
 */
describe('NgModule-based routing', () => {
  let dir: string;

  const write = (relPath: string, contents: string): void => {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  };

  const flatPaths = (routes: RouteNode[]): string[] =>
    routes.flatMap(r => [r.fullPath ?? r.path, ...flatPaths(r.children ?? [])]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-manifest-angular-ngmodule-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows a lazy NgModule to the sibling routing module that calls RouterModule.forChild', async () => {
    write('src/app/app-routing.module.ts', `
      import { NgModule } from '@angular/core';
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: '', redirectTo: 'loans', pathMatch: 'full' },
        { path: 'loans', loadChildren: () => import('./loans/loans.module').then(m => m.LoansModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)], exports: [RouterModule] })
      export class AppRoutingModule {}
    `);
    write('src/app/loans/loans.module.ts', `
      import { NgModule } from '@angular/core';
      import { CommonModule } from '@angular/common';
      import { LoansRoutingModule } from './loans-routing.module';
      @NgModule({ imports: [CommonModule, LoansRoutingModule] })
      export class LoansModule {}
    `);
    write('src/app/loans/loans-routing.module.ts', `
      import { NgModule } from '@angular/core';
      import { RouterModule, Routes } from '@angular/router';
      import { LoanOfferComponent } from './loan-offer.component';
      import { BankDetailComponent } from './bank-detail.component';
      const routes: Routes = [
        { path: '', redirectTo: 'loan-offer', pathMatch: 'full' },
        { path: 'loan-offer', component: LoanOfferComponent },
        { path: 'bank', component: BankDetailComponent, children: [
          { path: 'detail', component: BankDetailComponent },
        ] },
      ];
      @NgModule({ imports: [RouterModule.forChild(routes)], exports: [RouterModule] })
      export class LoansRoutingModule {}
    `);
    write('src/app/loans/loan-offer.component.ts', `
      import { Component } from '@angular/core';
      @Component({ selector: 'app-loan-offer', template: '<div>offer</div>' })
      export class LoanOfferComponent {}
    `);
    write('src/app/loans/bank-detail.component.ts', `
      import { Component } from '@angular/core';
      @Component({ selector: 'app-bank-detail', template: '<div>bank</div>' })
      export class BankDetailComponent {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(flatPaths(manifest.routes)).toEqual([
      '/', '/loans', '/loans', '/loans/loan-offer', '/loans/bank', '/loans/bank/detail',
    ]);
    expect(manifest.routes[1].children).toMatchObject([
      { path: '', redirectTo: 'loan-offer', pathMatch: 'full' },
      { path: 'loan-offer', component: { export: 'LoanOfferComponent' } },
      { path: 'bank', component: { export: 'BankDetailComponent' } },
    ]);
    expect(manifest.diagnostics ?? []).toEqual([]);
  });

  it('points a child route at the routing module it is written in, not the module that lazy-loaded it', async () => {
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'home', loadChildren: () => import('./home/home.module').then(m => m.HomeModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/home/home.module.ts', `
      import { HomeRoutingModule } from './home-routing.module';
      @NgModule({ imports: [HomeRoutingModule] })
      export class HomeModule {}
    `);
    write('src/app/home/home-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      import { HomeComponent } from './home.component';
      const routes: Routes = [
        { path: '', component: HomeComponent },
      ];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class HomeRoutingModule {}
    `);
    write('src/app/home/home.component.ts', `
      import { Component } from '@angular/core';
      @Component({ selector: 'app-home', template: '<div>home</div>' })
      export class HomeComponent {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(manifest.routes[0].source?.path).toBe('src/app/app-routing.module.ts');
    expect(manifest.routes[0].children?.[0].source?.path).toBe('src/app/home/home-routing.module.ts');
  });

  it('reaches a feature lazy-loaded from inside another feature\'s routing module', async () => {
    // The second half of the report: modules referenced only from a `*-routing.module.ts` were
    // never reached at all, and — because the warning fired one level up — logged nothing either.
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'loans', loadChildren: () => import('./loans/loans.module').then(m => m.LoansModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/loans/loans.module.ts', `
      import { LoansRoutingModule } from './loans-routing.module';
      @NgModule({ imports: [LoansRoutingModule] })
      export class LoansModule {}
    `);
    write('src/app/loans/loans-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        // Relative to THIS file, not to the module that loaded it.
        { path: 'funding', loadChildren: () => import('../funding/funding.module').then(m => m.FundingModule) },
      ];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class LoansRoutingModule {}
    `);
    write('src/app/funding/funding.module.ts', `
      import { FundingRoutingModule } from './funding-routing.module';
      @NgModule({ imports: [FundingRoutingModule] })
      export class FundingModule {}
    `);
    write('src/app/funding/funding-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      import { FundingComponent } from './funding.component';
      const routes: Routes = [{ path: 'start', component: FundingComponent }];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class FundingRoutingModule {}
    `);
    write('src/app/funding/funding.component.ts', `
      import { Component } from '@angular/core';
      @Component({ selector: 'app-funding', template: '<div>funding</div>' })
      export class FundingComponent {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(flatPaths(manifest.routes)).toEqual(['/loans', '/loans/funding', '/loans/funding/start']);
    expect(manifest.diagnostics ?? []).toEqual([]);
  });

  it('finds a route table whose variable is not named `routes`, and one passed inline', async () => {
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const appRoutes: Routes = [
        { path: 'a', loadChildren: () => import('./a/a.module').then(m => m.AModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(appRoutes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/a/a.module.ts', `
      import { ARoutingModule } from './a-routing.module';
      @NgModule({ imports: [ARoutingModule] })
      export class AModule {}
    `);
    write('src/app/a/a-routing.module.ts', `
      import { RouterModule } from '@angular/router';
      @NgModule({ imports: [RouterModule.forChild([{ path: 'inline' }])] })
      export class ARoutingModule {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(flatPaths(manifest.routes)).toEqual(['/a', '/a/inline']);
    expect(manifest.diagnostics ?? []).toEqual([]);
  });

  it('resolves a route table the routing module imports from a sibling file', async () => {
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'b', loadChildren: () => import('./b/b.module').then(m => m.BModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/b/b.module.ts', `
      import { BRoutingModule } from './b-routing.module';
      @NgModule({ imports: [BRoutingModule] })
      export class BModule {}
    `);
    write('src/app/b/b-routing.module.ts', `
      import { RouterModule } from '@angular/router';
      import { routes as bRoutes } from './b.routes';
      @NgModule({ imports: [RouterModule.forChild(bRoutes)] })
      export class BRoutingModule {}
    `);
    write('src/app/b/b.routes.ts', `
      import { Routes } from '@angular/router';
      export const routes: Routes = [{ path: 'elsewhere' }];
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(flatPaths(manifest.routes)).toEqual(['/b', '/b/elsewhere']);
    // The nested route is written in b.routes.ts — that is where a reader must go to change it.
    expect(manifest.routes[0].children?.[0].source?.path).toBe('src/app/b/b.routes.ts');
  });

  it('reaches a routing module one module further out, through a feature barrel', async () => {
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'c', loadChildren: () => import('./c/c.module').then(m => m.CModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/c/c.module.ts', `
      import { CInnerModule } from './inner/c-inner.module';
      @NgModule({ imports: [CInnerModule] })
      export class CModule {}
    `);
    write('src/app/c/inner/c-inner.module.ts', `
      import { CRoutingModule } from './c-routing.module';
      @NgModule({ imports: [CRoutingModule] })
      export class CInnerModule {}
    `);
    write('src/app/c/inner/c-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [{ path: 'deep' }];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class CRoutingModule {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(flatPaths(manifest.routes)).toEqual(['/c', '/c/deep']);
  });

  it('expands a spread of a locally-declared module array in `imports:`', async () => {
    // Caught on akveo/ngx-admin, not on a fixture: ten of its twelve feature modules list their
    // imports directly and resolved fine, and the two that write `imports: [...MODULES]` were the
    // only ones left reporting no routes — a partial pass that reads as a pass.
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'f', loadChildren: () => import('./f/f.module').then(m => m.FModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/f/f.module.ts', `
      import { CommonModule } from '@angular/common';
      import { NbDialogModule } from '@nebular/theme';
      import { FRoutingModule } from './f-routing.module';
      const MODULES = [CommonModule, FRoutingModule, NbDialogModule.forChild()];
      @NgModule({ imports: [...MODULES] })
      export class FModule {}
    `);
    write('src/app/f/f-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [{ path: 'spread' }];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class FRoutingModule {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(flatPaths(manifest.routes)).toEqual(['/f', '/f/spread']);
    expect(manifest.diagnostics ?? []).toEqual([]);
  });

  it('concatenates every route table the lazy module\'s import graph registers', async () => {
    // Angular's own semantics: `RouterModule.forChild(...)` is a multi-provider, so a feature
    // module that imports a SECOND routed module registers both tables at that level. ngx-admin
    // does exactly this — PagesModule imports PagesRoutingModule and MiscellaneousModule.
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'g', loadChildren: () => import('./g/g.module').then(m => m.GModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/g/g.module.ts', `
      import { GRoutingModule } from './g-routing.module';
      import { ExtraModule } from './extra/extra.module';
      @NgModule({ imports: [GRoutingModule, ExtraModule] })
      export class GModule {}
    `);
    write('src/app/g/g-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [{ path: 'main' }];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class GRoutingModule {}
    `);
    write('src/app/g/extra/extra.module.ts', `
      import { ExtraRoutingModule } from './extra-routing.module';
      @NgModule({ imports: [ExtraRoutingModule] })
      export class ExtraModule {}
    `);
    write('src/app/g/extra/extra-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [{ path: 'extra' }];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class ExtraRoutingModule {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(flatPaths(manifest.routes)).toEqual(['/g', '/g/main', '/g/extra']);
  });

  it('still reports a lazy module that registers no routes anywhere in its import graph', async () => {
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'd', loadChildren: () => import('./d/d.module').then(m => m.DModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/d/d.module.ts', `
      import { CommonModule } from '@angular/common';
      @NgModule({ imports: [CommonModule] })
      export class DModule {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(manifest.diagnostics).toContain(
      'loadChildren target has no routes array: ./d/d.module (resolved to src/app/d/d.module.ts; ' +
      'no routes array, and no RouterModule.forChild(...) in it or in the modules it imports)',
    );
    // ...and typed, so a consumer can tell "this page map has a hole" from "this app has one page".
    expect(manifest.uncapturable).toContainEqual(
      expect.objectContaining({ kind: 'unresolvedLazyChunk' }),
    );
  });

  it('terminates on a cycle between two routing modules', async () => {
    write('src/app/app-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'e', loadChildren: () => import('./e/e.module').then(m => m.EModule) },
      ];
      @NgModule({ imports: [RouterModule.forRoot(routes)] })
      export class AppRoutingModule {}
    `);
    write('src/app/e/e.module.ts', `
      import { ERoutingModule } from './e-routing.module';
      @NgModule({ imports: [ERoutingModule] })
      export class EModule {}
    `);
    write('src/app/e/e-routing.module.ts', `
      import { RouterModule, Routes } from '@angular/router';
      const routes: Routes = [
        { path: 'loop', loadChildren: () => import('./e.module').then(m => m.EModule) },
      ];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class ERoutingModule {}
    `);

    const manifest = await extract({ cwd: dir, routesFile: 'app-routing.module.ts' });

    expect(flatPaths(manifest.routes)).toEqual(['/e', '/e/loop']);
    expect(manifest.diagnostics?.some(d => d.startsWith('loadChildren cycle detected'))).toBe(true);
  });
});
