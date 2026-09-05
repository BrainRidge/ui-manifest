import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, PACKAGE_VERSION } from '../src/version.js';

/**
 * `provenance.generator.version` is how a consumer knows which extractor produced a manifest — and
 * therefore which known behaviours and known gaps apply to it. A stale literal here reports the
 * wrong one confidently, which is worse than reporting none.
 *
 * The literal exists (rather than a `package.json` read) because the published `dist/` sits a
 * directory deeper than the source, so a relative read that works in the monorepo resolves to
 * nothing once installed. This test is the other half of that trade.
 */
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

describe('package identity', () => {
  it('matches package.json — bump both, or provenance lies about which build ran', () => {
    expect({ name: PACKAGE_NAME, version: PACKAGE_VERSION })
      .toEqual({ name: pkg.name, version: pkg.version });
  });
});
