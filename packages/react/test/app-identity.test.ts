import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { detectAppIdentity } from '../src/app-identity.js';

function files(...sources: string[]): Array<readonly [string, ts.SourceFile]> {
  return sources.map((text, i) => {
    const name = `src/file${i}.tsx`;
    return [name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)] as const;
  });
}

describe('detectAppIdentity (react)', () => {
  it('reads basename off a JSX router', () => {
    const app = detectAppIdentity({
      files: files(`export const App = () => <BrowserRouter basename="/portal"><Routes/></BrowserRouter>;`),
    });
    expect(app).toEqual({ baseHref: '/portal', routerMode: 'path', confidence: 'detected' });
  });

  it('reads basename out of a data-router options object', () => {
    const app = detectAppIdentity({
      files: files(`const router = createBrowserRouter(routes, { basename: '/admin/' });`),
    });
    expect(app.baseHref).toBe('/admin');
    expect(app.confidence).toBe('detected');
  });

  it('detects hash routing from either router form', () => {
    expect(detectAppIdentity({ files: files(`<HashRouter><Routes/></HashRouter>`) }).routerMode).toBe('hash');
    expect(detectAppIdentity({ files: files(`createHashRouter(routes)`) }).routerMode).toBe('hash');
  });

  it('carries basename and hash routing together', () => {
    const app = detectAppIdentity({
      files: files(`const r = createHashRouter(routes, { basename: '/app' });`),
    });
    expect(app).toEqual({ baseHref: '/app', routerMode: 'hash', confidence: 'detected' });
  });

  it('sees through a namespace import', () => {
    // `import * as Router from 'react-router-dom'` is legal and used; matching only bare
    // identifiers would silently miss every app written that way.
    const app = detectAppIdentity({
      files: files(`export const App = () => <Router.HashRouter basename="/ns"/>;`),
    });
    expect(app).toEqual({ baseHref: '/ns', routerMode: 'hash', confidence: 'detected' });
  });

  it('declines a non-literal basename rather than guessing', () => {
    // `basename={BASE}` needs a type checker to resolve, and this package deliberately loads none.
    // Reporting "/" with confidence "detected" would be a confident wrong answer; defaulting and
    // saying so is the honest one.
    const app = detectAppIdentity({ files: files(`<BrowserRouter basename={BASE}/>`) });
    expect(app).toEqual({ baseHref: '/', routerMode: 'path', confidence: 'default' });
  });

  it('defaults, and says so, when there is no router at all', () => {
    const app = detectAppIdentity({ files: files(`export const x = 1;`) });
    expect(app).toEqual({ baseHref: '/', routerMode: 'path', confidence: 'default' });
  });

  it('lets the caller override and marks it configured', () => {
    const app = detectAppIdentity({
      files: files(`<BrowserRouter basename="/detected"/>`),
      overrides: { baseHref: '/actual' },
    });
    expect(app).toEqual({ baseHref: '/actual', routerMode: 'path', confidence: 'configured' });
  });
});
