import type { AngularExtractConfig } from '../src/config.js';

export function fakeConfig(overrides: Partial<AngularExtractConfig> = {}): AngularExtractConfig {
  return {
    targetDir: '/fake/src/app',
    routesFile: '/fake/src/app/app.routes.ts',
    withDom: false,
    dependencyGraph: false,
    cwd: '/fake',
    ...overrides,
  };
}
