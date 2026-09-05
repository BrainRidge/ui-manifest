import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, PACKAGE_VERSION } from '../src/version.js';

/** See the Angular package's version.test.ts — a stale literal reports the wrong extractor build
 *  confidently, which is worse than reporting none. */
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

describe('package identity', () => {
  it('matches package.json — bump both, or provenance lies about which build ran', () => {
    expect({ name: PACKAGE_NAME, version: PACKAGE_VERSION })
      .toEqual({ name: pkg.name, version: pkg.version });
  });
});
