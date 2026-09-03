import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { detectComponents, type DetectedComponent } from '../src/component-detector.js';
import { extractProps } from '../src/props-parser.js';
import { createSourceFile } from './helpers.js';

function firstComponent(src: string): { sf: ts.SourceFile; component: DetectedComponent } {
  const sf = createSourceFile(src);
  const { components } = detectComponents(sf);
  if (!components[0]) throw new Error('expected at least one detected component in fixture');
  return { sf, component: components[0] };
}

describe('extractProps', () => {
  it('extracts an inline TS type literal param, marking on* names as event handlers', () => {
    const { sf, component } = firstComponent(`
      export const Button = (props: { label: string; onClick: () => void; disabled?: boolean }) => {
        return <button onClick={props.onClick}>{props.label}</button>;
      };
    `);
    const props = extractProps(component, sf);
    expect(props).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'label', required: true, source: 'ts-type' }),
        expect.objectContaining({ name: 'onClick', required: true, source: 'ts-type', isEventHandler: true }),
        expect.objectContaining({ name: 'disabled', required: false, source: 'ts-type' }),
      ]),
    );
  });

  it('resolves a locally-declared interface referenced by name (one level, same file)', () => {
    const { sf, component } = firstComponent(`
      interface CardProps {
        title: string;
        subtitle?: string;
      }
      export const Card = (props: CardProps) => {
        return <div>{props.title}</div>;
      };
    `);
    const props = extractProps(component, sf);
    expect(props).toEqual([
      { name: 'title', required: true, source: 'ts-type', type: 'string' },
      { name: 'subtitle', required: false, source: 'ts-type', type: 'string' },
    ]);
  });

  it('resolves a locally-declared `type X = {...}` alias referenced by name', () => {
    const { sf, component } = firstComponent(`
      type RowProps = { id: string };
      export const Row = (props: RowProps) => {
        return <tr />;
      };
    `);
    const props = extractProps(component, sf);
    expect(props).toEqual([{ name: 'id', required: true, source: 'ts-type', type: 'string' }]);
  });

  it('reads props from the React.FC<Props> generic argument when the param itself is untyped', () => {
    const { sf, component } = firstComponent(`
      import React from 'react';
      interface BannerProps { message: string; }
      export const Banner: React.FC<BannerProps> = ({ message }) => {
        return <div>{message}</div>;
      };
    `);
    const props = extractProps(component, sf);
    expect(props).toEqual([{ name: 'message', required: true, source: 'ts-type', type: 'string' }]);
  });

  it('reads props from a class `extends Component<Props, State>` generic', () => {
    const { sf, component } = firstComponent(`
      import React from 'react';
      interface ClockProps { label: string; }
      export class Clock extends React.Component<ClockProps, {}> {
        render() {
          return <div>{this.props.label}</div>;
        }
      }
    `);
    const props = extractProps(component, sf);
    expect(props).toEqual([{ name: 'label', required: true, source: 'ts-type', type: 'string' }]);
  });

  it('falls back to a static ComponentName.propTypes assignment when no TS type is present', () => {
    const { sf, component } = firstComponent(`
      function Legacy(props) {
        return <div>{props.title}</div>;
      }
      Legacy.propTypes = {
        title: PropTypes.string.isRequired,
        onSave: PropTypes.func,
      };
    `);
    const props = extractProps(component, sf);
    expect(props).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'title', required: true, source: 'prop-types', type: 'string' }),
        expect.objectContaining({ name: 'onSave', required: false, source: 'prop-types', type: 'func', isEventHandler: true }),
      ]),
    );
  });

  it('never fabricates props when neither a TS type nor propTypes is found', () => {
    const { sf, component } = firstComponent(`
      export const Blank = (props) => {
        return <div>{props.x}</div>;
      };
    `);
    const props = extractProps(component, sf);
    expect(props).toEqual([]);
  });
});
