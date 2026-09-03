import { describe, expect, it } from 'vitest';
import { chooseFramework, detectExtractors } from '../src/detect.js';

describe('chooseFramework (pure decision logic)', () => {
  it('auto-selects the only installed extractor when none is explicitly requested', () => {
    const chosen = chooseFramework({ angular: '/path/to/angular/cli.js' });
    expect(chosen).toEqual({ framework: 'angular', cliPath: '/path/to/angular/cli.js' });
  });

  it('throws with an actionable message when nothing is installed', () => {
    expect(() => chooseFramework({})).toThrow(/no extractor installed/i);
  });

  it('throws asking for --framework when more than one extractor is installed and none was requested', () => {
    expect(() =>
      chooseFramework({ angular: '/a/cli.js', react: '/r/cli.js' }),
    ).toThrow(/--framework/);
  });

  it('honors an explicit --framework when the requested one is installed', () => {
    const chosen = chooseFramework({ angular: '/a/cli.js', react: '/r/cli.js' }, 'react');
    expect(chosen).toEqual({ framework: 'react', cliPath: '/r/cli.js' });
  });

  it('throws when the explicitly requested framework is not installed', () => {
    expect(() => chooseFramework({ react: '/r/cli.js' }, 'angular')).toThrow(/angular.*isn't installed/i);
  });

  it('throws when --framework is neither "angular" nor "react"', () => {
    expect(() => chooseFramework({ angular: '/a/cli.js' }, 'vue')).toThrow(/must be "angular" or "react"/);
  });
});

describe('detectExtractors (real filesystem probing)', () => {
  it('finds both real workspace-linked extractor packages in this monorepo', () => {
    // This monorepo has both @ui-manifest/angular and @ui-manifest/react built and workspace-
    // linked, so this is a genuine integration check, not a mock — if either package's `main`/
    // `cli.js` build output layout ever drifts from what detect.ts assumes, this test catches it.
    const found = detectExtractors();
    expect(found.angular).toBeDefined();
    expect(found.angular).toMatch(/cli\.js$/);
    expect(found.react).toBeDefined();
    expect(found.react).toMatch(/cli\.js$/);
  });
});
