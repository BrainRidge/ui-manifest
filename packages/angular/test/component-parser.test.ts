import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectComponents, extractComponentsFromSource } from '../src/component-parser.js';
import { fakeConfig } from './helpers.js';

describe('extractComponentsFromSource — decorator inputs/outputs', () => {
  const src = `
    import { Component, Input, Output, EventEmitter } from '@angular/core';

    @Component({ selector: 'app-foo', standalone: true })
    export class FooComponent {
      @Input() name: string;
      @Input('aliasedName') otherName: string;
      @Input({ required: true }) mustHave: boolean;
      @Input({ required: true, alias: 'aliasedRequired' }) reqAliased: string;

      @Output() changed = new EventEmitter<string>();
      @Output('aliasedEvent') fired = new EventEmitter();
    }
  `;

  it('extracts @Input()/@Output() with alias and required, sorted by name', async () => {
    const diagnostics: string[] = [];
    const [component] = await extractComponentsFromSource(src, '/fake/src/app/foo.component.ts', fakeConfig(), diagnostics);

    expect(component.className).toBe('FooComponent');
    expect(component.selector).toBe('app-foo');
    expect(component.standalone).toBe(true);
    expect(component.inputs.map(i => i.name)).toEqual(['mustHave', 'name', 'otherName', 'reqAliased']);

    expect(component.inputs).toContainEqual({ name: 'name', type: 'string', kind: 'decorator' });
    expect(component.inputs).toContainEqual({ name: 'otherName', alias: 'aliasedName', type: 'string', kind: 'decorator' });
    expect(component.inputs).toContainEqual({ name: 'mustHave', type: 'boolean', kind: 'decorator', required: true });
    expect(component.inputs).toContainEqual({
      name: 'reqAliased',
      alias: 'aliasedRequired',
      type: 'string',
      kind: 'decorator',
      required: true,
    });

    expect(component.outputs.map(o => o.name)).toEqual(['changed', 'fired']);
    expect(component.outputs).toContainEqual({ name: 'changed', kind: 'decorator' });
    expect(component.outputs).toContainEqual({ name: 'fired', alias: 'aliasedEvent', kind: 'decorator' });
    expect(diagnostics).toEqual([]);
  });
});

describe('extractComponentsFromSource — signal inputs/outputs', () => {
  const src = `
    import { Component, input, output } from '@angular/core';

    @Component({ selector: 'app-bar' })
    export class BarComponent {
      count = input<number>(0);
      label = input.required<string>();
      plain = input();

      saved = output<void>();
      simple = output();
    }
  `;

  it('extracts input()/output() signals, distinguishing required()', async () => {
    const diagnostics: string[] = [];
    const [component] = await extractComponentsFromSource(src, '/fake/src/app/bar.component.ts', fakeConfig(), diagnostics);

    expect(component.inputs).toContainEqual({ name: 'count', type: 'number', kind: 'signal' });
    expect(component.inputs).toContainEqual({ name: 'label', type: 'string', kind: 'signal', required: true });
    expect(component.inputs).toContainEqual({ name: 'plain', kind: 'signal' });

    expect(component.outputs).toContainEqual({ name: 'saved', type: 'void', kind: 'signal' });
    expect(component.outputs).toContainEqual({ name: 'simple', kind: 'signal' });
  });
});

describe('extractComponentsFromSource — template detection', () => {
  it('records templateUrl without parsing DOM when withDom is false', async () => {
    const src = `
      import { Component } from '@angular/core';
      @Component({ selector: 'app-ext', templateUrl: './ext.component.html' })
      export class ExtComponent {}
    `;
    const diagnostics: string[] = [];
    const [component] = await extractComponentsFromSource(src, '/fake/src/app/ext.component.ts', fakeConfig({ withDom: false }), diagnostics);

    expect(component.templateUrl).toBe('./ext.component.html');
    expect(component.inlineTemplate).toBeUndefined();
    expect(component.dom).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it('parses an inline template into dom[] when withDom is true, without touching disk', async () => {
    const src = `
      import { Component } from '@angular/core';
      @Component({ selector: 'app-inline', template: '<div>{{greeting}}</div>' })
      export class InlineComponent {}
    `;
    const diagnostics: string[] = [];
    const [component] = await extractComponentsFromSource(
      src,
      '/fake/src/app/inline.component.ts',
      fakeConfig({ withDom: true }),
      diagnostics,
    );

    expect(component.inlineTemplate).toBe(true);
    expect(component.templateUrl).toBeUndefined();
    expect(component.dom).toMatchObject([
      {
        type: 'element',
        extraction: 'compiler',
        el: 'div',
        attrs: {},
        props: [],
        events: [],
        children: [{ type: 'interpolation', extraction: 'compiler', interpolation: '{{greeting}}' }],
      },
    ]);
  });

  it('does not import @angular/compiler-dependent code paths when withDom is false', async () => {
    // No assertion needed beyond "this resolves without throwing" — the point is that base
    // extraction works even for a template-bearing component when --with-dom isn't passed.
    const src = `
      import { Component } from '@angular/core';
      @Component({ selector: 'app-x', template: '<div>{{x}}</div>' })
      export class XComponent {}
    `;
    const diagnostics: string[] = [];
    const [component] = await extractComponentsFromSource(src, '/fake/src/app/x.component.ts', fakeConfig({ withDom: false }), diagnostics);
    expect(component.dom).toBeUndefined();
  });
});

describe('collectComponents — file-system driven, external templateUrl', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-manifest-angular-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads external templateUrl files and parses their DOM', async () => {
    writeFileSync(
      join(dir, 'widget.component.ts'),
      `
        import { Component } from '@angular/core';
        @Component({ selector: 'app-widget', templateUrl: './widget.component.html' })
        export class WidgetComponent {}
      `,
      'utf8',
    );
    writeFileSync(join(dir, 'widget.component.html'), `<p>hi</p>`, 'utf8');
    writeFileSync(
      join(dir, 'widget.component.spec.ts'),
      `
        import { Component } from '@angular/core';
        @Component({ selector: 'app-widget-spec' })
        export class WidgetSpecComponent {}
      `,
      'utf8',
    );

    const config = fakeConfig({ targetDir: dir, withDom: true, cwd: dir });
    const { components, diagnostics } = await collectComponents(config);

    expect(components).toHaveLength(1);
    expect(components[0].className).toBe('WidgetComponent');
    expect(components[0].filePath).toBe('widget.component.ts');
    expect(components[0].dom).toMatchObject([
      {
        type: 'element',
        extraction: 'compiler',
        el: 'p',
        attrs: {},
        props: [],
        events: [],
        children: [{ type: 'text', extraction: 'compiler', value: 'hi' }],
      },
    ]);
    expect(diagnostics).toEqual([]);
  });
});

/**
 * Regression coverage for #1.
 *
 * Discovery used to filter on `rel.endsWith('.component.ts')`. Angular v20's CLI stopped appending
 * `.component` to generated filenames — `ng generate component book-list` writes `book-list.ts`
 * exporting `class BookList` — so that filter matched nothing at all on a v20 app, and the extractor
 * reported zero components without erroring. These tests pin the rule that replaced it: the
 * `@Component` decorator decides, the filename does not.
 */
describe('collectComponents — discovery is by decorator, not filename', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-manifest-angular-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const component = (selector: string, className: string) => `
    import { Component } from '@angular/core';
    @Component({ selector: '${selector}', template: '<p>x</p>' })
    export class ${className} {}
  `;

  async function collectFrom(): Promise<string[]> {
    const { components } = await collectComponents(fakeConfig({ targetDir: dir, cwd: dir }));
    return components.map(c => c.className);
  }

  it('finds Angular 20 style components, whose files carry no .component suffix', async () => {
    writeFileSync(join(dir, 'book-list.ts'), component('app-book-list', 'BookList'), 'utf8');
    writeFileSync(join(dir, 'app.ts'), component('app-root', 'App'), 'utf8');

    expect(await collectFrom()).toEqual(['App', 'BookList']);
  });

  it('finds both naming conventions side by side, as a part-migrated app has', async () => {
    writeFileSync(join(dir, 'book-list.ts'), component('app-book-list', 'BookList'), 'utf8');
    writeFileSync(join(dir, 'legacy.component.ts'), component('app-legacy', 'LegacyComponent'), 'utf8');

    expect(await collectFrom()).toEqual(['BookList', 'LegacyComponent']);
  });

  it('ignores .ts files with no @Component, so widening the walk adds no false positives', async () => {
    writeFileSync(join(dir, 'book-list.ts'), component('app-book-list', 'BookList'), 'utf8');
    writeFileSync(
      join(dir, 'book.service.ts'),
      `import { Injectable } from '@angular/core';\n@Injectable()\nexport class BookService {}`,
      'utf8',
    );
    writeFileSync(join(dir, 'auth-guard.ts'), `export class AuthGuard {}`, 'utf8');
    writeFileSync(join(dir, 'book.ts'), `export interface Book { id: number }`, 'utf8');

    expect(await collectFrom()).toEqual(['BookList']);
  });

  it('excludes test files, whose @Component hosts are fixtures rather than app code', async () => {
    writeFileSync(join(dir, 'book-list.ts'), component('app-book-list', 'BookList'), 'utf8');
    writeFileSync(join(dir, 'book-list.spec.ts'), component('app-spec-host', 'SpecHost'), 'utf8');
    writeFileSync(join(dir, 'book-list.test.ts'), component('app-test-host', 'TestHost'), 'utf8');
    // The pre-#1 filter excluded `.spec.ts` too, but only vacuously: a path cannot end in both
    // `.spec.ts` and `.component.ts`. This is the first version where the exclusion does work.
    writeFileSync(join(dir, 'legacy.component.spec.ts'), component('app-legacy-spec', 'LegacySpecHost'), 'utf8');

    expect(await collectFrom()).toEqual(['BookList']);
  });

  it('excludes .d.ts declarations, which cannot carry a decorated class', async () => {
    writeFileSync(join(dir, 'book-list.ts'), component('app-book-list', 'BookList'), 'utf8');
    writeFileSync(join(dir, 'shims.d.ts'), `declare module '*.svg';\n// @Component`, 'utf8');

    expect(await collectFrom()).toEqual(['BookList']);
  });

  it('finds several components declared in one file, as a single-file feature has', async () => {
    writeFileSync(
      join(dir, 'feature.ts'),
      `${component('app-parent', 'Parent')}\n${component('app-child', 'Child')}`,
      'utf8',
    );

    expect(await collectFrom()).toEqual(['Parent', 'Child']);
  });
});
