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

  it('emits a diagnostic instead of a silent empty result when no pattern matches a route-defining import', () => {
    // `Route` says this file means to define routes; failing to read them is exactly what the
    // diagnostic exists to report. (A file importing react-router only to NAVIGATE defines no
    // route table and gets no diagnostic — see the navigation-only case further down.)
    const sf = createSourceFile(
      `
      import { Route } from 'react-router-dom';
      import { routeTable } from './route-table';

      export function AppRoutes() {
        return <div>{routeTable.map(makeRoute)}</div>;
      }
    `,
      'AppRoutes.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/AppRoutes.tsx');
    expect(result.routes).toEqual([]);
    expect(result.diagnostics).toEqual(['routing pattern unresolved for src/AppRoutes.tsx']);
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

  // ---------------------------------------------------------------------------------------------
  // react-router-dom v3/v4/v5: <Switch>, component=, render=, <Redirect>. A large share of
  // long-lived React apps are still pinned to v4/v5, and every one of them used to parse to zero
  // routes plus one "routing pattern unresolved" diagnostic per router file.
  // ---------------------------------------------------------------------------------------------

  it('parses a v4/v5 <Switch> table with component= targets, mapping `exact` to pathMatch: "full"', () => {
    const sf = createSourceFile(
      `
      import React from 'react';
      import { Switch, Route } from 'react-router-dom';
      import LandingPage from '../pages/LandingPage';
      import VerificationPage from '../pages/VerificationPage';

      class App extends React.Component {
        render() {
          return (
            <Switch>
              <Route exact path="/" component={LandingPage} />
              <Route path="/verification" component={VerificationPage} />
            </Switch>
          );
        }
      }

      export default App;
    `,
      'App.js',
    );
    const result = parseRoutesInFile(sf, 'src/app/App.js');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes).toEqual([
      {
        path: '/',
        component: { module: '../pages/LandingPage', export: 'LandingPage' },
        pathMatch: 'full',
        routingPattern: 'jsx-routes',
      },
      {
        path: '/verification',
        component: { module: '../pages/VerificationPage', export: 'VerificationPage' },
        routingPattern: 'jsx-routes',
      },
    ]);
  });

  it('resolves a v4/v5 render prop to the component its JSX renders', () => {
    const sf = createSourceFile(
      `
      import { Switch, Route } from 'react-router-dom';
      import FlinksPage from './pages/FlinksPage';

      export default function Section() {
        return (
          <Switch>
            <Route path="/flinks" render={props => <FlinksPage {...props} />} />
          </Switch>
        );
      }
    `,
      'Section.js',
    );
    const result = parseRoutesInFile(sf, 'src/Section.js');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes[0]).toMatchObject({
      path: '/flinks',
      component: { module: './pages/FlinksPage', export: 'FlinksPage' },
    });
  });

  it('reads <Redirect from/to> inside a <Switch>, and a from-less catch-all <Redirect>', () => {
    const sf = createSourceFile(
      `
      import { Switch, Route, Redirect } from 'react-router-dom';
      import Home from './Home';

      export default function App() {
        return (
          <Switch>
            <Route path="/home" component={Home} />
            <Redirect exact from="/old-home" to="/home" />
            <Redirect to="/home" />
          </Switch>
        );
      }
    `,
      'App.js',
    );
    const result = parseRoutesInFile(sf, 'src/App.js');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes).toEqual([
      { path: '/home', component: { module: './Home', export: 'Home' }, routingPattern: 'jsx-routes' },
      { path: '/old-home', redirectTo: '/home', pathMatch: 'full', routingPattern: 'jsx-routes' },
      // No `from` to report, so `path` stays '' rather than inventing a "*" the source never wrote.
      { path: '', redirectTo: '/home', routingPattern: 'jsx-routes' },
    ]);
  });

  it('parses bare <Route>s with no <Switch> above them — v4/v5’s other legal shape', () => {
    const sf = createSourceFile(
      `
      import { Route } from 'react-router-dom';
      import Sidebar from './Sidebar';
      import Main from './Main';

      export default function Shell() {
        return (
          <div className="shell">
            <Route path="/x" component={Sidebar} />
            <Route path="/y" component={Main} />
          </div>
        );
      }
    `,
      'Shell.js',
    );
    const result = parseRoutesInFile(sf, 'src/Shell.js');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes.map(r => r.path)).toEqual(['/x', '/y']);
  });

  it('does NOT treat a <Redirect> used as ordinary render logic as a route', () => {
    // `return <Redirect to="/login"/>` inside a component is a navigation side effect, not a
    // route definition — reporting it would invent a screen the app does not have. And since the
    // file imports no route-defining name, there is no pattern to fail at either: no diagnostic.
    const sf = createSourceFile(
      `
      import { Redirect } from 'react-router-dom';

      export default function RedirectWithSearch({ authenticated, search }) {
        if (!authenticated) return <Redirect to={\`/login\${search}\`} />;
        return <Redirect to="/dashboard" />;
      }
    `,
      'redirect-with-search.js',
    );
    const result = parseRoutesInFile(sf, 'src/helpers/redirect-with-search.js');
    expect(result.routes).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('nests a v4/v5 subtree written as a <Switch> inside the parent <Route>', () => {
    const sf = createSourceFile(
      `
      import { Switch, Route } from 'react-router-dom';
      import AppLayout from './AppLayout';
      import Profile from './Profile';

      export default function App() {
        return (
          <Switch>
            <Route path="/app" component={AppLayout}>
              <Switch>
                <Route path="/app/profile" component={Profile} />
              </Switch>
            </Route>
          </Switch>
        );
      }
    `,
      'App.js',
    );
    const result = parseRoutesInFile(sf, 'src/App.js');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ path: '/app', component: { export: 'AppLayout' } });
    expect(result.routes[0]!.children).toEqual([
      { path: '/app/profile', component: { module: './Profile', export: 'Profile' } },
    ]);
  });

  it('finds a conditionally rendered <Route> inside a route table', () => {
    // `{isAdmin && <Route .../>}` is common, and a direct-children-only scan drops it while the
    // sibling routes still parse — so no diagnostic fires and the loss is silent.
    const sf = createSourceFile(
      `
      import { Switch, Route } from 'react-router-dom';
      import Home from './Home';
      import Admin from './Admin';
      import Beta from './Beta';

      export default function App({ isAdmin, flag }) {
        return (
          <Switch>
            <Route path="/" component={Home} />
            {isAdmin && <Route path="/admin" component={Admin} />}
            {flag ? <Route path="/beta" component={Beta} /> : null}
          </Switch>
        );
      }
    `,
      'App.js',
    );
    const result = parseRoutesInFile(sf, 'src/App.js');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes.map(r => r.path)).toEqual(['/', '/admin', '/beta']);
  });

  it('emits no diagnostic for a file that imports react-router only to navigate', () => {
    // Most files in a real app that touch react-router touch it for Link/withRouter/hooks. They
    // define no route table, so `routes: []` from them is trustworthy and must come with no
    // diagnostic — see docs/schema.md's "Diagnostics, not silent gaps".
    const sf = createSourceFile(
      `
      import { Link, withRouter } from 'react-router-dom';

      const MMHeader = ({ history }) => (
        <header>
          <Link to="/home">Home</Link>
          <button onClick={() => history.push('/account')}>Account</button>
        </header>
      );

      export default withRouter(MMHeader);
    `,
      'MMHeader.js',
    );
    const result = parseRoutesInFile(sf, 'src/components/header/MMHeader.js');
    expect(result.routes).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reads a v5 route whose target is its JSX body, including a <Redirect> body', () => {
    const sf = createSourceFile(
      `
      import { Switch, Route, Redirect } from 'react-router-dom';
      import { ProfilePage } from '../Pages/ProfilePage/ProfilePage';
      import { Home } from '../Pages/Home/Home';

      export function App() {
        return (
          <Switch>
            <Route path="/profile/:username">
              <ProfilePage />
            </Route>
            <Route exact path="/">
              <Home />
            </Route>
            <Route path="*">
              <Redirect to="/" />
            </Route>
          </Switch>
        );
      }
    `,
      'App.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/App.tsx');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes).toEqual([
      {
        path: '/profile/:username',
        component: { module: '../Pages/ProfilePage/ProfilePage', export: 'ProfilePage' },
        routingPattern: 'jsx-routes',
      },
      {
        path: '/',
        component: { module: '../Pages/Home/Home', export: 'Home' },
        pathMatch: 'full',
        routingPattern: 'jsx-routes',
      },
      { path: '*', redirectTo: '/', routingPattern: 'jsx-routes' },
    ]);
  });

  it('treats a custom path-carrying wrapper inside a route table as a route', () => {
    // `<UserOnlyRoute path="/settings">` is how v4/v5 apps write a guarded route. <Switch> reads
    // `path` off the child itself, so an element carrying `path` in a route table is a route
    // entry by construction — no guess about naming conventions involved.
    const sf = createSourceFile(
      `
      import { Switch, Route } from 'react-router-dom';
      import { Settings } from './Settings';
      import { Login } from './Login';

      export function App({ userIsLogged }) {
        return (
          <Switch>
            <UserOnlyRoute exact path="/settings" userIsLogged={userIsLogged}>
              <Settings />
            </UserOnlyRoute>
            <GuestOnlyRoute exact path="/login" userIsLogged={userIsLogged}>
              <Login />
            </GuestOnlyRoute>
          </Switch>
        );
      }
    `,
      'App.tsx',
    );
    const result = parseRoutesInFile(sf, 'src/App.tsx');
    expect(result.diagnostics).toEqual([]);
    expect(result.routes).toEqual([
      { path: '/settings', component: { module: './Settings', export: 'Settings' }, pathMatch: 'full', routingPattern: 'jsx-routes' },
      { path: '/login', component: { module: './Login', export: 'Login' }, pathMatch: 'full', routingPattern: 'jsx-routes' },
    ]);
  });

  it('does not read a route body target when a prop already named one', () => {
    // `component=` is the explicit statement of the target; the body here is a v5 render-prop
    // child, not a second component to overwrite it with.
    const sf = createSourceFile(
      `
      import { Switch, Route } from 'react-router-dom';
      import Dashboard from './Dashboard';
      import Spinner from './Spinner';

      export default function App() {
        return (
          <Switch>
            <Route path="/dash" component={Dashboard}>
              <Spinner />
            </Route>
          </Switch>
        );
      }
    `,
      'App.js',
    );
    const result = parseRoutesInFile(sf, 'src/App.js');
    expect(result.routes[0]).toMatchObject({ path: '/dash', component: { export: 'Dashboard' } });
  });

  it('leaves the target unresolved when a route body has several element children', () => {
    // Nothing in the source says which of them is "the" route component, and RouteNode.component
    // is singular — picking one would assert a structure the app never stated.
    const sf = createSourceFile(
      `
      import { Switch, Route } from 'react-router-dom';
      import Header from './Header';
      import Body from './Body';

      export default function App() {
        return (
          <Switch>
            <Route path="/x">
              <Header />
              <Body />
            </Route>
          </Switch>
        );
      }
    `,
      'App.js',
    );
    const result = parseRoutesInFile(sf, 'src/App.js');
    expect(result.routes).toEqual([{ path: '/x', routingPattern: 'jsx-routes' }]);
  });
});
