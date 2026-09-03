import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';

describe('resolveConfig', () => {
  it('defaults targetDir to "src/app" and routesFile to "app.routes.ts" under it, relative to cwd', () => {
    const config = resolveConfig({ cwd: '/repo' });
    expect(config.targetDir).toBe(resolve('/repo/src/app'));
    expect(config.routesFile).toBe(resolve('/repo/src/app/app.routes.ts'));
    expect(config.withDom).toBe(false);
    expect(config.dependencyGraph).toBe(false);
  });

  it('resolves routesFile relative to targetDir, not cwd or repo root', () => {
    const config = resolveConfig({ cwd: '/repo', targetDir: 'client/app', routesFile: 'routing/app.routes.ts' });
    expect(config.targetDir).toBe(resolve('/repo/client/app'));
    expect(config.routesFile).toBe(resolve('/repo/client/app/routing/app.routes.ts'));
  });

  it('defaults cwd to process.cwd() when not supplied', () => {
    const config = resolveConfig({});
    expect(config.cwd).toBe(resolve(process.cwd()));
  });

  it('throws when dependencyGraph is requested without withDom', () => {
    expect(() => resolveConfig({ dependencyGraph: true })).toThrow('--dependency-graph requires --with-dom');
    expect(() => resolveConfig({ dependencyGraph: true, withDom: false })).toThrow(
      '--dependency-graph requires --with-dom',
    );
  });

  it('allows dependencyGraph when withDom is also set', () => {
    const config = resolveConfig({ dependencyGraph: true, withDom: true });
    expect(config.dependencyGraph).toBe(true);
    expect(config.withDom).toBe(true);
  });
});
