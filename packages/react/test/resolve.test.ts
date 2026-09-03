import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { resolveRouteDependencyTree, type ComponentNode } from '@ui-manifest/core';
import { detectComponents } from '../src/component-detector.js';
import { buildDom } from '../src/jsx-dom-parser.js';
import {
  buildComponentIndex,
  createMatchFn,
  resolveJsxTagToComponent,
  type IndexableComponent,
  type ResolveContext,
} from '../src/resolve.js';
import { createSourceFile } from './helpers.js';

/** Build a small in-memory "app" from {filePath: source}, running detectComponents + buildDom
 *  over every .tsx file — mirroring what `src/index.ts`'s `extract()` does per file, but without
 *  touching disk. Non-.tsx files (e.g. a barrel `index.ts`) are still parsed and kept in `files`
 *  since resolve.ts needs them for import/barrel resolution even though they define no components. */
function buildApp(sources: Record<string, string>): ResolveContext {
  const files = new Map<string, ts.SourceFile>();
  for (const [filePath, src] of Object.entries(sources)) {
    files.set(filePath, createSourceFile(src, filePath));
  }

  const indexable: IndexableComponent[] = [];
  for (const [filePath, sf] of files) {
    if (!filePath.endsWith('.tsx')) continue;
    const { components } = detectComponents(sf);
    for (const c of components) {
      const node: ComponentNode = {
        className: c.name,
        filePath,
        inputs: [],
        outputs: [],
        props: [],
        dom: buildDom(c.primaryJsx, sf),
      };
      indexable.push({ node, isDefaultExport: c.isDefaultExport });
    }
  }

  const { componentIndex, sameFileIndex } = buildComponentIndex(indexable);
  return { files, componentIndex, sameFileIndex };
}

function componentNamed(ctx: ResolveContext, filePath: string, className: string): ComponentNode {
  const node = Array.from(ctx.componentIndex.values()).find(c => c.filePath === filePath && c.className === className);
  if (!node) throw new Error(`no component named ${className} indexed for ${filePath}`);
  return node;
}

describe('resolveJsxTagToComponent / createMatchFn', () => {
  it('resolves a default import regardless of the target component\'s own internal name', () => {
    const ctx = buildApp({
      'src/App.tsx': `
        import UserCard from './UserCard';
        export function App() {
          return <div><UserCard /></div>;
        }
      `,
      'src/UserCard.tsx': `
        function Card() {
          return <span className="card" />;
        }
        export default Card;
      `,
    });

    const match = resolveJsxTagToComponent('UserCard', 'src/App.tsx', ctx);
    expect(match).toBeDefined();
    expect(match!.className).toBe('Card');
    expect(match!.filePath).toBe('src/UserCard.tsx');
  });

  it('resolves a named import to the correctly-named exported component', () => {
    const ctx = buildApp({
      'src/Layout.tsx': `
        import { Header } from './Header';
        export function Layout() {
          return <div><Header /></div>;
        }
      `,
      'src/Header.tsx': `
        export function Header() {
          return <header />;
        }
      `,
    });

    const match = resolveJsxTagToComponent('Header', 'src/Layout.tsx', ctx);
    expect(match?.className).toBe('Header');
    expect(match?.filePath).toBe('src/Header.tsx');
  });

  it('chases one level of barrel (index.ts) re-export', () => {
    const ctx = buildApp({
      'src/Toolbar.tsx': `
        import { Button } from './components';
        export function Toolbar() {
          return <div><Button /></div>;
        }
      `,
      'src/components/index.ts': `
        export { Button } from './Button';
      `,
      'src/components/Button.tsx': `
        export function Button() {
          return <button />;
        }
      `,
    });

    const match = resolveJsxTagToComponent('Button', 'src/Toolbar.tsx', ctx);
    expect(match?.className).toBe('Button');
    expect(match?.filePath).toBe('src/components/Button.tsx');
  });

  it('returns undefined for a tag with no matching import declaration in the current file', () => {
    const ctx = buildApp({
      'src/Solo.tsx': `
        export function Solo() {
          return <div><Unimported /></div>;
        }
      `,
    });
    expect(resolveJsxTagToComponent('Unimported', 'src/Solo.tsx', ctx)).toBeUndefined();
  });

  it('resolves a named-export component used in the SAME file it is declared in, without an import', () => {
    // The extremely common "App.tsx defines App and its own router config" shape — no import to
    // chase at all, since the reference is to a local declaration in the very same file.
    const ctx = buildApp({
      'src/App.tsx': `
        function Header() { return <header />; }
        export function App() {
          return <div><Header /></div>;
        }
      `,
    });
    const match = resolveJsxTagToComponent('Header', 'src/App.tsx', ctx);
    expect(match?.className).toBe('Header');
    expect(match?.filePath).toBe('src/App.tsx');
  });

  it('resolves a DEFAULT-exported component used in the SAME file it is declared in', () => {
    // componentIndex keys default exports under the literal "default", not the function's real
    // name — a same-file lookup must go through sameFileIndex (keyed by className) instead, or
    // this would incorrectly miss.
    const ctx = buildApp({
      'src/App.tsx': `
        export default function App() {
          return <div><App /></div>;
        }
      `,
    });
    const match = resolveJsxTagToComponent('App', 'src/App.tsx', ctx);
    expect(match?.className).toBe('App');
    expect(match?.filePath).toBe('src/App.tsx');
  });
});

describe('resolve.ts driving core\'s resolveRouteDependencyTree', () => {
  it('splices a matched child component in place, annotated with provenance', () => {
    const ctx = buildApp({
      'src/App.tsx': `
        import UserCard from './UserCard';
        export function App() {
          return <div><UserCard /></div>;
        }
      `,
      'src/UserCard.tsx': `
        export default function UserCard() {
          return <span>hi</span>;
        }
      `,
    });

    const root = componentNamed(ctx, 'src/App.tsx', 'App');
    const matchFn = createMatchFn(ctx);
    const result = resolveRouteDependencyTree('/', root, matchFn);

    const div = result.tree[0];
    if (div.type !== 'element') throw new Error('expected element');
    const boundary = div.children[0];
    expect(boundary).toMatchObject({ type: 'component-boundary', tag: 'UserCard', componentClassName: 'UserCard' });
    if (boundary.type !== 'component-boundary') throw new Error('expected component-boundary');
    expect(boundary.children[0]).toMatchObject({ type: 'element', el: 'span' });
  });

  it('splices two levels deep across three different files (not just one hop from the route root)', () => {
    // App.tsx -> <Header/> (from Header.tsx) -> <Logo/> (from Logo.tsx). Logo's own import
    // bindings live in Header.tsx, NOT App.tsx — a matchFn fixed to the root's file can never
    // resolve it. This is the realistic shape of a real component tree (nesting through more
    // than one file), not an edge case.
    const ctx = buildApp({
      'src/App.tsx': `
        import { Header } from './Header';
        export function App() {
          return <div><Header /></div>;
        }
      `,
      'src/Header.tsx': `
        import { Logo } from './Logo';
        export function Header() {
          return <header><Logo /></header>;
        }
      `,
      'src/Logo.tsx': `
        export function Logo() {
          return <img />;
        }
      `,
    });

    const root = componentNamed(ctx, 'src/App.tsx', 'App');
    const matchFn = createMatchFn(ctx);
    const result = resolveRouteDependencyTree('/', root, matchFn);

    const div = result.tree[0];
    if (div.type !== 'element') throw new Error('expected element');
    const headerBoundary = div.children[0];
    expect(headerBoundary).toMatchObject({ type: 'component-boundary', componentClassName: 'Header' });
    if (headerBoundary.type !== 'component-boundary') throw new Error('expected component-boundary for Header');

    const headerEl = headerBoundary.children[0];
    if (headerEl.type !== 'element') throw new Error('expected <header> element');
    const logoBoundary = headerEl.children[0];
    expect(logoBoundary).toMatchObject({ type: 'component-boundary', componentClassName: 'Logo' });
  });

  it('emits a cycle marker for self-inclusion resolved through an import binding', () => {
    const ctx = buildApp({
      'src/Recursive.tsx': `
        import { Recursive as RecursiveAlias } from './Recursive';
        export function Recursive() {
          return <div><RecursiveAlias /></div>;
        }
      `,
    });

    const root = componentNamed(ctx, 'src/Recursive.tsx', 'Recursive');
    const matchFn = createMatchFn(ctx);
    const result = resolveRouteDependencyTree('/recursive', root, matchFn);

    const div = result.tree[0];
    if (div.type !== 'element') throw new Error('expected element');
    const marker = div.children[0];
    expect(marker).toMatchObject({
      type: 'cycle-detected',
      tag: 'RecursiveAlias',
      componentClassName: 'Recursive',
      cyclePath: ['Recursive'],
    });
  });
});
