import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectAppIdentity } from '../src/app-identity.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A minimal Angular layout: `<cwd>/src/index.html` + `<cwd>/src/app/`. */
function project(files: Record<string, string> = {}): { cwd: string; targetDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'ui-manifest-app-'));
  made.push(cwd);
  mkdirSync(join(cwd, 'src', 'app'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return { cwd, targetDir: join(cwd, 'src', 'app') };
}

describe('detectAppIdentity', () => {
  it('reads <base href> out of index.html', () => {
    const { cwd, targetDir } = project({
      'src/index.html': '<!doctype html>\n<html><head>\n<base href="/portal/">\n</head></html>',
    });
    const { app } = detectAppIdentity({ targetDir, cwd });
    expect(app).toEqual({ baseHref: '/portal', routerMode: 'path', confidence: 'detected' });
  });

  it('accepts either quote style and any attribute order', () => {
    const { cwd, targetDir } = project({
      'src/index.html': "<base data-x='1' href='/shop/' >",
    });
    expect(detectAppIdentity({ targetDir, cwd }).app.baseHref).toBe('/shop');
  });

  it('falls back to the APP_BASE_HREF provider when there is no tag', () => {
    const { cwd, targetDir } = project({
      'src/app/app.config.ts':
        "providers: [{ provide: APP_BASE_HREF, useValue: '/admin/' }]",
    });
    expect(detectAppIdentity({ targetDir, cwd }).app.baseHref).toBe('/admin');
  });

  it('detects hash routing in either the standalone or NgModule form', () => {
    for (const [file, body] of [
      ['src/app/app.config.ts', 'provideRouter(routes, withHashLocation())'],
      ['src/app/app.module.ts', 'RouterModule.forRoot(routes, { useHash: true })'],
    ] as const) {
      const { cwd, targetDir } = project({ [file]: body });
      const { app } = detectAppIdentity({ targetDir, cwd });
      expect(app.routerMode, file).toBe('hash');
      expect(app.confidence, file).toBe('detected');
    }
  });

  it('reports a default through `confidence`, not through `diagnostics`', () => {
    // The whole reason `confidence` exists: a defaulted "/" is byte-identical to a detected one,
    // and a consumer matching URLs against an app actually served from a subpath will match
    // nothing with no way to tell why.
    //
    // But it is NOT a diagnostic. `docs/schema.md` defines those as "this part of the manifest is
    // incomplete", and a defaulted base href is complete and merely less certain. Most apps set no
    // <base href>, so a diagnostic here would be non-empty on nearly every run and would train
    // readers to ignore a field whose value depends on usually being empty. The CLI prints a hint
    // to stderr instead.
    const { cwd, targetDir } = project();
    const { app, diagnostics } = detectAppIdentity({ targetDir, cwd });
    expect(app).toEqual({ baseHref: '/', routerMode: 'path', confidence: 'default' });
    expect(diagnostics).toEqual([]);
  });

  it('a root <base href="/"> is a real detection, not a default', () => {
    const { cwd, targetDir } = project({ 'src/index.html': '<base href="/">' });
    const { app, diagnostics } = detectAppIdentity({ targetDir, cwd });
    expect(app.baseHref).toBe('/');
    expect(app.confidence).toBe('detected');
    expect(diagnostics).toEqual([]);
  });

  it('treats a relative base href as the root rather than inventing a path', () => {
    // `<base href="./">` means "wherever this document is", which a static read cannot resolve.
    const { cwd, targetDir } = project({ 'src/index.html': '<base href="./">' });
    expect(detectAppIdentity({ targetDir, cwd }).app.baseHref).toBe('/');
  });

  it('lets the caller override, and marks it as configured', () => {
    const { cwd, targetDir } = project({ 'src/index.html': '<base href="/detected/">' });
    const { app, diagnostics } = detectAppIdentity({
      targetDir, cwd, overrides: { baseHref: '/actual/', routerMode: 'hash' },
    });
    expect(app).toEqual({ baseHref: '/actual', routerMode: 'hash', confidence: 'configured' });
    expect(diagnostics).toEqual([]);
  });

  it('does not scan components, so a comment about useHash cannot fake a detection', () => {
    // A false positive here is worse than a miss: a miss defaults and says so, where this would
    // report hash routing with confidence "detected" for an app that has none.
    const { cwd, targetDir } = project({
      'src/app/thing.component.ts': '// TODO: consider { useHash: true } one day\n',
    });
    expect(detectAppIdentity({ targetDir, cwd }).app.routerMode).toBe('path');
  });
});
