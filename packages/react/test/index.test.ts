import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extract } from '../src/index.js';

/**
 * End-to-end coverage for a Babel-compiled, react-router-dom v4/v5 app: every component in a plain
 * `.js` file, class components exported through `connect()`, route tables written as `<Switch>`.
 *
 * This lives at the `extract()` level deliberately. The bug it pins was a `.tsx`/`.jsx`-only
 * filename filter in `index.ts` itself, ahead of `detectComponents` — every parser unit test kept
 * passing while a real app of this shape produced `components: []`, `routes: []` and an empty
 * `dependencyGraph`. Nothing below this seam could have caught it.
 */
describe('extract on a .js + react-router-dom v4 app', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-manifest-react-extract-'));
    mkdirSync(join(dir, 'src/app'), { recursive: true });
    mkdirSync(join(dir, 'src/components'), { recursive: true });
    mkdirSync(join(dir, 'src/pages'), { recursive: true });

    writeFileSync(
      join(dir, 'src/app/App.js'),
      `
        import React from 'react';
        import { Switch, Route, Redirect } from 'react-router-dom';
        import LandingPage from '../pages/LandingPage';
        import VerificationPage from '../pages/VerificationPage';

        class App extends React.Component {
          render() {
            return (
              <Switch>
                <Route exact path="/" component={LandingPage} />
                <Route path="/verification" component={VerificationPage} />
                <Redirect to="/" />
              </Switch>
            );
          }
        }

        export default App;
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/pages/LandingPage.js'),
      `
        import React from 'react';
        import { connect } from 'react-redux';
        import MMHeader from '../components/MMHeader';

        const mapStateToProps = state => ({ user: state.user });

        class LandingPage extends React.Component {
          render() {
            return (
              <div className="landing">
                <MMHeader />
                <button onClick={this.props.onStart}>Start</button>
              </div>
            );
          }
        }

        export default connect(mapStateToProps)(LandingPage);
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/pages/VerificationPage.js'),
      `
        import React from 'react';

        const VerificationPage = () => <section><p>Verify</p></section>;

        export default VerificationPage;
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/components/MMHeader.js'),
      `
        import React from 'react';
        import { Link, withRouter } from 'react-router-dom';

        const MMHeader = () => <header><Link to="/">Home</Link></header>;

        export default withRouter(MMHeader);
      `,
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds every component defined in a .js file', async () => {
    const manifest = await extract({ dir: join(dir, 'src') });
    expect(manifest.components.map(c => c.className).sort()).toEqual([
      'App',
      'LandingPage',
      'MMHeader',
      'VerificationPage',
    ]);
  });

  it('parses the <Switch> route table, with exact -> pathMatch and the trailing redirect', async () => {
    const manifest = await extract({ dir: join(dir, 'src') });
    expect(manifest.routes).toEqual([
      {
        path: '/',
        fullPath: '/',
        component: { module: '../pages/LandingPage', export: 'LandingPage' },
        pathMatch: 'full',
        routingPattern: 'jsx-routes',
      },
      {
        path: '/verification',
        fullPath: '/verification',
        component: { module: '../pages/VerificationPage', export: 'VerificationPage' },
        routingPattern: 'jsx-routes',
      },
      { path: '', fullPath: '/', redirectTo: '/', routingPattern: 'jsx-routes' },
    ]);
  });

  it('reports no diagnostics: MMHeader imports react-router only to navigate', async () => {
    const manifest = await extract({ dir: join(dir, 'src') });
    expect(manifest.diagnostics).toBeUndefined();
  });

  it('builds a dependency graph through a connect()-wrapped default export', async () => {
    const manifest = await extract({ dir: join(dir, 'src'), dependencyGraph: true });
    const landing = manifest.dependencyGraph?.find(t => t.routePath === '/');
    // `import LandingPage from '../pages/LandingPage'` resolves only if the connected export is
    // indexed as this file's default — and MMHeader is spliced in as a component boundary (rather
    // than left a plain element) only if the .js walk detected it in the first place.
    expect(landing?.rootComponent).toBe('LandingPage');
    expect(JSON.stringify(landing?.tree)).toContain('"componentClassName":"MMHeader"');
  });

  it('reports a route whose component could not be resolved, instead of dropping its tree in silence', async () => {
    // `class X extends SomeOtherComponent` is not a shape detection recognizes (the base is not
    // React.Component and there is no own render()), so the route resolves to no component. The
    // tree is legitimately missing; saying nothing about it is what would be wrong.
    writeFileSync(
      join(dir, 'src/pages/FavoritesPage.js'),
      `
        import React from 'react';
        import { LandingPage } from './LandingPage';

        class FavoritesPage extends LandingPage {
          renderTabs() { return <ul />; }
        }

        export default FavoritesPage;
      `,
      'utf8',
    );
    writeFileSync(
      join(dir, 'src/app/App.js'),
      `
        import React from 'react';
        import { Switch, Route } from 'react-router-dom';
        import FavoritesPage from '../pages/FavoritesPage';

        export default function App() {
          return (
            <Switch>
              <Route path="/favorites" component={FavoritesPage} />
            </Switch>
          );
        }
      `,
      'utf8',
    );

    const manifest = await extract({ dir: join(dir, 'src'), dependencyGraph: true });
    expect(manifest.dependencyGraph?.map(t => t.routePath)).not.toContain('/favorites');
    expect(manifest.diagnostics).toContain(
      'dependency graph: no component found for route "/favorites" (export "FavoritesPage" from "../pages/FavoritesPage")',
    );
  });
});
