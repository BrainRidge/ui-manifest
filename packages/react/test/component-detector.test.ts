import { describe, expect, it } from 'vitest';
import { detectComponents } from '../src/component-detector.js';
import { createSourceFile } from './helpers.js';

describe('detectComponents', () => {
  it('detects a function component bound to a const arrow function', () => {
    const sf = createSourceFile(`
      export const Greeting = (props: { name: string }) => {
        return <div>Hello {props.name}</div>;
      };
    `);
    const { components, unnamedSkippedCount } = detectComponents(sf);
    expect(unnamedSkippedCount).toBe(0);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ name: 'Greeting', kind: 'function', isDefaultExport: false });
    expect(components[0].primaryJsx).toBeDefined();
  });

  it('walks through if-branch early returns to find the primary (last) JSX return', () => {
    const sf = createSourceFile(`
      export default function Panel(props: { loading: boolean }) {
        if (props.loading) {
          return <Spinner />;
        }
        return <div className="ready" />;
      }
    `);
    const { components } = detectComponents(sf);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Panel');
    expect(components[0].isDefaultExport).toBe(true);
    expect(components[0].primaryJsx!.getText()).toContain('ready');
  });

  it('detects a class component extending React.Component via render()', () => {
    const sf = createSourceFile(`
      import React from 'react';
      export class Card extends React.Component {
        render() {
          return <div className="card" />;
        }
      }
    `);
    const { components } = detectComponents(sf);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ name: 'Card', kind: 'class' });
  });

  it('unwraps two levels of memo(forwardRef(...)) wrapping to find the underlying function', () => {
    const sf = createSourceFile(`
      import { forwardRef, memo } from 'react';
      export const Input = memo(forwardRef((props: any, ref: any) => {
        return <input ref={ref} {...props} />;
      }));
    `);
    const { components } = detectComponents(sf);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Input');
    expect(components[0].fn).toBeDefined();
  });

  it('skips and counts an anonymous default-exported function component', () => {
    const sf = createSourceFile(`
      export default function (props: { children: any }) {
        return <div>{props.children}</div>;
      }
    `);
    const { components, unnamedSkippedCount } = detectComponents(sf);
    expect(components).toHaveLength(0);
    expect(unnamedSkippedCount).toBe(1);
  });

  it('skips and counts an anonymous default-exported forwardRef component', () => {
    const sf = createSourceFile(`
      import { forwardRef } from 'react';
      export default forwardRef((props: any, ref: any) => {
        return <input ref={ref} />;
      });
    `);
    const { components, unnamedSkippedCount } = detectComponents(sf);
    expect(components).toHaveLength(0);
    expect(unnamedSkippedCount).toBe(1);
  });

  it('ignores a lowercase-bound const even when it returns JSX', () => {
    const sf = createSourceFile(`
      const helper = () => {
        return <div />;
      };
    `);
    const { components } = detectComponents(sf);
    expect(components).toHaveLength(0);
  });

  it('flips isDefaultExport for `export default X;` referring to an earlier declaration', () => {
    const sf = createSourceFile(`
      function Card() {
        return <div className="card" />;
      }
      export default Card;
    `);
    const { components } = detectComponents(sf);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ name: 'Card', isDefaultExport: true });
  });

  it('detects a component in a plain .js file, which parses JSX exactly as .jsx does', () => {
    const sf = createSourceFile(
      `
      import React from 'react';

      class MMLogin extends React.Component {
        render() {
          return <form className="login"><input name="user" /></form>;
        }
      }

      export default MMLogin;
    `,
      'MMLogin.js',
    );
    const { components } = detectComponents(sf);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ name: 'MMLogin', kind: 'class', isDefaultExport: true });
  });

  it('flips isDefaultExport through an HOC call chain: connect()/withRouter/compose', () => {
    // `buildComponentIndex` keys a default export under the literal name "default", so getting
    // this wrong makes `import Page from './Page'` resolve to nothing — dropping every route that
    // points at a connected component from `dependencyGraph`.
    for (const exported of [
      'connect(mapStateToProps, mapDispatchToProps)(CustomerProfilePage)',
      'withRouter(CustomerProfilePage)',
      'compose(withRouter, connect(mapStateToProps))(CustomerProfilePage)',
      'connect(mapStateToProps)(withRouter(CustomerProfilePage))',
    ]) {
      const sf = createSourceFile(
        `
        import React from 'react';
        import { connect } from 'react-redux';

        const mapStateToProps = state => ({ user: state.user });
        const mapDispatchToProps = dispatch => ({ dispatch });

        class CustomerProfilePage extends React.Component {
          render() { return <div className="profile" />; }
        }

        export default ${exported};
      `,
        'CustomerProfilePage.js',
      );
      const { components } = detectComponents(sf);
      expect(components.map(c => c.name)).toEqual(['CustomerProfilePage']);
      expect(components[0]!.isDefaultExport, exported).toBe(true);
    }
  });

  it('leaves isDefaultExport alone when an HOC expression references two local components', () => {
    // Two candidates and no way to tell which is being exported — leaving both unresolved keeps a
    // wrong "default" key out of the index, which is worse than a missing one.
    const sf = createSourceFile(
      `
      import React from 'react';

      const Fallback = () => <div />;
      const Page = () => <main />;

      export default withBoundary(Fallback)(Page);
    `,
      'Page.js',
    );
    const { components } = detectComponents(sf);
    expect(components.map(c => c.isDefaultExport)).toEqual([false, false]);
  });

  it('does not mistake a sibling component rendered by an inline callback for the default export', () => {
    const sf = createSourceFile(
      `
      const Header = () => <header />;

      export default loadable(() => <Header />);
    `,
      'Header.js',
    );
    const { components } = detectComponents(sf);
    expect(components.map(c => c.name)).toEqual(['Header']);
    expect(components[0]!.isDefaultExport).toBe(false);
  });
});
