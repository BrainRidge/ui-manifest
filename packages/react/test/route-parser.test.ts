import { describe, expect, it } from 'vitest';
import { parseRoutesInFile } from '../src/route-parser/index.js';
import { createSourceFile } from './helpers.js';

describe('route-parser', () => {
  it('detects routing setups imported from the base "react-router" package, not just "react-router-dom"', () => {
    // React Router v6.4+/v7 exports Routes/Route/createBrowserRouter from the base `react-router`
    // package itself — real apps (including react-router's own official examples) increasingly
    // import directly from it. A file importing only from "react-router" must not be silently
    // skipped the way it would be if the dispatcher only recognized "react-router-dom".
    const sf = createSourceFile(
      `
      import { Routes, Route } from 'react-router';

      export default function App() {
        return (
          <Routes>
            <Route path="/" element={<Home />} />
          </Routes>
        );
      }
    `,
      'App.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/App.tsx');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/', component: { export: 'Home' } });
  });

  it('parses a router-config (createBrowserRouter) route array, including nested children', () => {
    const sf = createSourceFile(
      `
      import { createBrowserRouter } from 'react-router-dom';
      import Home from './Home';
      import Layout from './Layout';
      import Settings from './pages/Settings';

      export const router = createBrowserRouter([
        { path: '/', element: <Home /> },
        {
          path: '/app',
          element: <Layout />,
          children: [
            { path: 'settings', element: <Settings /> },
          ],
        },
      ]);
    `,
      'router.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/router.tsx');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes).toHaveLength(2);
    expect(result.routes[0]).toMatchObject({
      path: '/',
      component: { module: './Home', export: 'Home' },
      routingPattern: 'router-config',
    });
    expect(result.routes[1].children).toHaveLength(1);
    expect(result.routes[1].children![0]).toMatchObject({
      path: 'settings',
      component: { module: './pages/Settings', export: 'Settings' },
    });
  });

  it('detects withNavigationPrompt-wrapped route components as best-effort canDeactivate text', () => {
    const sf = createSourceFile(
      `
      import { createBrowserRouter } from 'react-router-dom';
      import { withNavigationPrompt } from 'react-router-navigation-prompt';
      import RawForm from './RawForm';

      const GuardedForm = withNavigationPrompt(RawForm);

      export const router = createBrowserRouter([
        { path: '/edit', element: <GuardedForm /> },
      ]);
    `,
      'router.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/router.tsx');
    expect(result.routes[0].guards?.canDeactivate?.map(g => g.name)).toEqual(['withNavigationPrompt']);
  });

  it('detects usePrompt() calls inside a same-file route component as best-effort canDeactivate text', () => {
    const sf = createSourceFile(
      `
      import { createBrowserRouter, usePrompt } from 'react-router-dom';

      function EditForm() {
        usePrompt('Discard changes?', true);
        return <form />;
      }

      export const router = createBrowserRouter([
        { path: '/edit', element: <EditForm /> },
      ]);
    `,
      'router.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/router.tsx');
    expect(result.routes[0].guards?.canDeactivate?.map(g => g.name)).toEqual(['usePrompt']);
  });

  it('parses a <Routes>/<Route> JSX tree nested inside <BrowserRouter>, preserving index and catch-all routes', () => {
    const sf = createSourceFile(
      `
      import { BrowserRouter, Routes, Route } from 'react-router-dom';
      import Home from './Home';
      import About from './About';
      import NotFound from './NotFound';

      export function App() {
        return (
          <BrowserRouter>
            <Routes>
              <Route index element={<Home />} />
              <Route path="/about" element={<About />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        );
      }
    `,
      'App.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/App.tsx');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes).toHaveLength(3);
    expect(result.routes[0]).toMatchObject({ path: '', component: { export: 'Home' }, routingPattern: 'jsx-routes' });
    expect(result.routes[1]).toMatchObject({ path: '/about', component: { export: 'About' } });
    expect(result.routes[2]).toMatchObject({ path: '*', component: { export: 'NotFound' } });
  });

  it('walks nested <Route> children for layout routes', () => {
    const sf = createSourceFile(
      `
      import { Routes, Route } from 'react-router-dom';
      import Layout from './Layout';
      import Settings from './Settings';

      export function App() {
        return (
          <Routes>
            <Route path="/app" element={<Layout />}>
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        );
      }
    `,
      'App.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/App.tsx');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].children).toHaveLength(1);
    expect(result.routes[0].children![0]).toMatchObject({ path: 'settings', component: { export: 'Settings' } });
  });

  it('emits a diagnostic instead of a silent empty result when no pattern matches a react-router-dom import', () => {
    const sf = createSourceFile(
      `
      import { useNavigate } from 'react-router-dom';

      export function GoHome() {
        const navigate = useNavigate();
        return <button onClick={() => navigate('/')}>Home</button>;
      }
    `,
      'GoHome.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/GoHome.tsx');
    expect(result.routes).toEqual([]);
    expect(result.diagnostics).toEqual(['routing pattern unresolved for src/GoHome.tsx']);
  });

  it('contributes nothing for a file that does not import react-router-dom at all', () => {
    const sf = createSourceFile(`export const NotARoute = () => <div />;`, 'Plain.tsx');
    const result = parseRoutesInFile(sf, 'src/Plain.tsx');
    expect(result).toEqual({ routes: [], diagnostics: [] });
  });

  it('resolves the data-router `Component: X` shorthand (a direct reference, no JSX wrapper)', () => {
    const sf = createSourceFile(
      `
      import { createBrowserRouter } from 'react-router-dom';
      import Layout from './Layout';

      export const router = createBrowserRouter([
        { path: '/', Component: Layout, children: [{ index: true, Component: Home }] },
      ]);

      function Home() { return <h2>Home</h2>; }
    `,
      'router.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/router.tsx');
    expect(result.routes[0]).toMatchObject({ path: '/', component: { module: './Layout', export: 'Layout' } });
    expect(result.routes[0]!.children![0]).toMatchObject({ component: { module: 'src/router.tsx', export: 'Home' } });
  });

  it('does not mistake a lowercase JSX host element for a component reference', () => {
    // <h2>Index</h2> is real, renderable JSX — just not a component. JSX's own capitalization
    // rule (lowercase-first = always a host element) means this is never ambiguous.
    const sf = createSourceFile(
      `
      import { Routes, Route } from 'react-router-dom';
      export function App() {
        return (
          <Routes>
            <Route index element={<h2>Index</h2>} />
          </Routes>
        );
      }
    `,
      'App.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/App.tsx');
    expect(result.routes[0]).toEqual({ path: '', routingPattern: 'jsx-routes' });
  });

  it('unwraps createBrowserRouter(createRoutesFromElements(<Route/>)) — the JSX-authored data-router shape', () => {
    const sf = createSourceFile(
      `
      import { createBrowserRouter, createRoutesFromElements, Route } from 'react-router-dom';

      const router = createBrowserRouter(
        createRoutesFromElements(
          <Route path="/" element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="about" element={<About />} />
          </Route>,
        ),
      );
    `,
      'router.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/router.tsx');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({
      path: '/',
      component: { export: 'Layout' },
      routingPattern: 'router-config',
    });
    expect(result.routes[0]!.children).toEqual([
      { path: '', component: { module: 'src/router.tsx', export: 'Home' } },
      { path: 'about', component: { module: 'src/router.tsx', export: 'About' } },
    ]);
  });
});
