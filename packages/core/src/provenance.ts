/**
 * Collect `RepoProvenance` from the git working tree, and `buildId` from CI.
 *
 * Every field is best-effort and every failure is silent-but-absent. This runs against arbitrary
 * checkouts — a tarball with no `.git`, a shallow CI clone, a machine with no `git` on PATH — and
 * none of those is an error: they mean the manifest is unpinned, which is a fact about the output
 * rather than a failure to produce it. The one thing never done here is substituting a plausible
 * value for a missing one: a branch name in place of a commit would look like a pin and move.
 *
 * `git` is invoked directly rather than via a dependency. It is one process per field, already on
 * every machine that has a checkout to read, and the alternative is a dependency in a package whose
 * whole appeal is that it has almost none.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';

import type { GeneratorProvenance, RepoProvenance } from './types/provenance.js';

/**
 * Resolve symlinks, or return the path unchanged.
 *
 * `git rev-parse --show-toplevel` reports a REAL path, so on any platform where the checkout sits
 * under a symlink the two disagree and `relative()` produces an escape-hatch path full of `..`.
 * macOS makes this the common case rather than an edge one — `/tmp` and `/var` are both symlinks
 * into `/private` — so a manifest generated in a temp checkout would report an `appRoot` naming
 * the developer's filesystem instead of a subtree of the repo.
 */
function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // the directory may not exist yet; a non-resolvable path is not a failure here
  }
}

/** Run one git command, or return undefined. Never throws, never prints. */
function git(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const value = out.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The build identifier of the CI run, if this is one.
 *
 * Ordered by specificity, not popularity: a run id identifies one execution, where a build number
 * can repeat across re-runs. Absent locally, which is correct — a developer's laptop has no build.
 */
function detectBuildId(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.GITHUB_RUN_ID ??
    env.BUILD_BUILDID ??          // Azure Pipelines
    env.CI_PIPELINE_ID ??         // GitLab
    env.BUILDKITE_BUILD_ID ??
    env.CIRCLE_WORKFLOW_ID ??
    undefined
  );
}

export interface CollectProvenanceOptions {
  /**
   * Where the extractor is scanning. Becomes `appRoot`, relative to the repository root — and it
   * is also the directory git is asked FROM, which matters more than it looks: `--dir` can point
   * at a checkout that is not the one the command was run in, and asking git about the current
   * directory would then pin the manifest to a completely unrelated repository's HEAD. That is the
   * worst failure available here, because the result looks exactly like a correct pin.
   */
  targetDir: string;
  /** Only a fallback origin for `appRoot` when the target is not in a git tree at all. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function collectRepoProvenance(options: CollectProvenanceOptions): RepoProvenance {
  const cwd = realpath(options.cwd);
  const targetDir = realpath(options.targetDir);
  // Every git question is asked from the SCANNED tree, not from the process's cwd — see
  // `targetDir` above.
  const root = git(['rev-parse', '--show-toplevel'], targetDir);
  if (!root) {
    // Not a git working tree. `appRoot` is still worth reporting relative to cwd — a consumer
    // knowing which directory was scanned is useful even when it cannot know which commit.
    const appRoot = relative(cwd, targetDir) || '.';
    return { appRoot };
  }

  const commit = git(['rev-parse', 'HEAD'], targetDir);
  // `--porcelain` is empty for a clean tree. Only meaningful once we know we have a commit:
  // "dirty" without one says nothing a consumer can use.
  const status = commit ? git(['status', '--porcelain'], targetDir) : undefined;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], targetDir);

  const provenance: RepoProvenance = {
    remoteUrl: git(['remote', 'get-url', 'origin'], targetDir),
    commit,
    // Committer date, ISO 8601 strict. Not the author date: two commits can share an author date
    // after a rebase, and what orders two manifests is when the code landed.
    commitTime: commit ? git(['show', '-s', '--format=%cI', 'HEAD'], targetDir) : undefined,
    // A detached HEAD reports "HEAD", which is not a branch name and should not be recorded as one.
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    dirty: commit ? Boolean(status) : undefined,
    appRoot: relative(root, targetDir) || '.',
  };

  // Absent, not null/empty: a consumer testing `if (provenance.commit)` should not have to also
  // test for the empty string, and JSON with explicit nulls everywhere reads as though something
  // failed rather than as though it was never available.
  for (const key of Object.keys(provenance) as (keyof RepoProvenance)[]) {
    if (provenance[key] === undefined) delete provenance[key];
  }
  return provenance;
}

export function generatorProvenance(
  name: string,
  version: string,
  passes: string[],
  env: NodeJS.ProcessEnv = process.env,
): GeneratorProvenance {
  const buildId = detectBuildId(env);
  return buildId ? { name, version, buildId, passes } : { name, version, passes };
}
