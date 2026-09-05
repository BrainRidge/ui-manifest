/**
 * This package's own identity, for `provenance.generator`.
 *
 * A literal rather than a read of `package.json`: the published `dist/` sits one directory deeper
 * than the source, so a relative read that works in the monorepo resolves to nothing once
 * installed — the kind of break that only shows up after publishing. The release checklist keeps
 * this in step with `package.json`, and `version.test.ts` fails the build if it drifts.
 */
export const PACKAGE_NAME = '@ui-manifest-json/angular';
export const PACKAGE_VERSION = '0.2.0';
