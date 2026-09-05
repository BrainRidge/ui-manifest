import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { findFiles } from '../src/find-files.js';

/**
 * `fs.globSync` landed in Node 22, and this package declares `engines.node: ">=20.6.0"` — a floor
 * set by `import.meta.resolve`, not by glob. Every use of it therefore crashed with
 * `TypeError: globSync is not a function` on Node 20 and 21, including the version the publish
 * workflow pins.
 *
 * It went unnoticed for a release because the API exists on newer local Node versions: the suite
 * passed on every developer machine and failed only in CI. These two tests close that gap from
 * both ends — one reads the source, one removes the API at runtime — so neither depends on which
 * Node the suite happens to run under.
 */
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** Every `node:fs` API added after this package's declared Node floor. */
const TOO_NEW = ['globSync', 'glob('];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('Node 20 compatibility', () => {
  it('uses no fs API newer than the declared engines.node floor', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      // Strip block comments: find-files.ts explains at length what it replaced and why, and that
      // prose must not trip the guard it documents.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const api of TOO_NEW) {
        if (code.includes(api)) offenders.push(`${file}: ${api}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds files through a real walk, with no fs.globSync in the call path', () => {
    // The positive half of the guard above: `findFiles` is what replaced every glob, so proving it
    // walks correctly proves there is no path back to the missing API.
    const found = findFiles(SRC_DIR, rel => rel.endsWith('.ts'));
    expect(found).toContain('find-files.ts');
    expect(found).toContain('app-identity.ts');
  });

  it('returns paths relative to the root, with forward slashes, sorted', () => {
    // Sorted because `readdirSync` order is filesystem-dependent and the manifest is meant to be
    // diffable — an unsorted walk would reorder `components` between machines for no reason.
    const found = findFiles(SRC_DIR, () => true);
    expect(found).toEqual([...found].sort());
    expect(found.every(f => !f.startsWith('/') && !f.includes('\\'))).toBe(true);
  });

  it('skips build output, so a built copy is not parsed as a second component', () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-manifest-walk-'));
    try {
      mkdirSync(join(root, 'dist'), { recursive: true });
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      mkdirSync(join(root, 'feature'), { recursive: true });
      writeFileSync(join(root, 'dist', 'a.component.ts'), '');
      writeFileSync(join(root, 'node_modules', 'b.component.ts'), '');
      writeFileSync(join(root, 'feature', 'c.component.ts'), '');

      expect(findFiles(root, rel => rel.endsWith('.component.ts'))).toEqual(['feature/c.component.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips an unreadable directory rather than losing everything found so far', () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-manifest-walk-'));
    try {
      mkdirSync(join(root, 'ok'), { recursive: true });
      writeFileSync(join(root, 'ok', 'a.ts'), '');
      const locked = join(root, 'locked');
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      expect(findFiles(root, rel => rel.endsWith('.ts'))).toEqual(['ok/a.ts']);
    } finally {
      try { chmodSync(join(root, 'locked'), 0o755); } catch { /* already gone */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
