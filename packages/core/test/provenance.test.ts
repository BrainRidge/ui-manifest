import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { collectRepoProvenance, generatorProvenance } from '../src/provenance.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(withGit: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'ui-manifest-prov-'));
  made.push(dir);
  mkdirSync(join(dir, 'src', 'app'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app', 'a.ts'), 'export const a = 1;\n');
  if (withGit) {
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('remote', 'add', 'origin', 'https://github.com/acme/web.git');
    run('add', '-A');
    run('commit', '-qm', 'initial');
  }
  return dir;
}

describe('collectRepoProvenance', () => {
  it('pins the commit, the remote and the scanned subtree', () => {
    const dir = tempRepo(true);
    const p = collectRepoProvenance({ targetDir: join(dir, 'src', 'app'), cwd: dir });

    expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(p.remoteUrl).toBe('https://github.com/acme/web.git');
    expect(p.branch).toBe('main');
    expect(p.dirty).toBe(false);
    // Relative to the REPO root, not to cwd: a consumer reconstructing a repo-relative path from a
    // manifest's filePath needs the same origin git uses.
    expect(p.appRoot).toBe('src/app');
    expect(p.commitTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports a dirty tree, because a commit alone would describe code that was never committed', () => {
    const dir = tempRepo(true);
    writeFileSync(join(dir, 'src', 'app', 'a.ts'), 'export const a = 2;\n');
    expect(collectRepoProvenance({ targetDir: join(dir, 'src', 'app'), cwd: dir }).dirty).toBe(true);
  });

  it('is unpinned rather than broken outside a git tree', () => {
    // A tarball, a vendored copy, a sandbox. Not an error: it means the manifest is unpinned, which
    // is a fact about the output, not a failure to produce one.
    const dir = tempRepo(false);
    const p = collectRepoProvenance({ targetDir: join(dir, 'src', 'app'), cwd: dir });

    expect(p.commit).toBeUndefined();
    expect(p.remoteUrl).toBeUndefined();
    expect(p.appRoot).toBe('src/app');
  });

  it('never substitutes a plausible value for a missing one', () => {
    // The failure worth guarding: a branch name where a commit should be looks like a pin and
    // moves. Absent is the only honest answer.
    const dir = tempRepo(false);
    const p = collectRepoProvenance({ targetDir: dir, cwd: dir });
    expect('commit' in p).toBe(false);
    expect('branch' in p).toBe(false);
    expect('dirty' in p).toBe(false);
  });

  it('omits a detached HEAD rather than recording "HEAD" as a branch', () => {
    const dir = tempRepo(true);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-q', sha], { cwd: dir, stdio: 'ignore' });
    const p = collectRepoProvenance({ targetDir: dir, cwd: dir });
    expect(p.commit).toBe(sha);
    expect(p.branch).toBeUndefined();
  });
});

describe('generatorProvenance', () => {
  it('records which passes actually ran, so a gap is distinguishable from a skip', () => {
    const g = generatorProvenance('@ui-manifest-json/angular', '0.2.0', ['routes', 'components'], {});
    expect(g.passes).toEqual(['routes', 'components']);
    expect(g.buildId).toBeUndefined();
  });

  it('picks up a CI run id where there is one', () => {
    expect(generatorProvenance('x', '1', [], { GITHUB_RUN_ID: '4821' }).buildId).toBe('4821');
    expect(generatorProvenance('x', '1', [], { BUILD_BUILDID: '99' }).buildId).toBe('99');
  });
});

describe('collectRepoProvenance across repositories', () => {
  it('pins the repo being SCANNED, not the one the command was run in', () => {
    // The failure this guards is the worst one available here, because it looks like success: run
    // the CLI from repo A with --dir pointing into repo B, and the manifest describes B's UI while
    // claiming A's commit. Every consumer then resolves those source paths against the wrong tree.
    const scanned = tempRepo(true);
    const runFrom = tempRepo(true);
    // Give the two different HEADs so the assertion cannot pass by coincidence.
    writeFileSync(join(runFrom, 'other.ts'), 'export const b = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: runFrom, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'second'], { cwd: runFrom, stdio: 'ignore' });

    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scanned, encoding: 'utf8' }).trim();
    const wrong = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runFrom, encoding: 'utf8' }).trim();
    expect(expected).not.toBe(wrong);

    const p = collectRepoProvenance({ targetDir: join(scanned, 'src', 'app'), cwd: runFrom });

    expect(p.commit).toBe(expected);
    // And appRoot stays inside the scanned repo rather than becoming an escape-hatch `../` path.
    expect(p.appRoot).toBe('src/app');
  });
});
