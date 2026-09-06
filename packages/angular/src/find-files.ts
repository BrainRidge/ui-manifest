/**
 * Recursive file discovery, without `fs.globSync`.
 *
 * `fs.globSync` landed in Node 22. This package declares `engines.node: ">=20.6.0"` — a floor set
 * by `import.meta.resolve`, not by glob — so every use of it crashed with
 * `TypeError: globSync is not a function` on Node 20 and 21, which includes the version the publish
 * workflow pins. It went unnoticed because the API exists on newer local Node versions, so the
 * suite passed everywhere except CI.
 *
 * A hand-rolled walk rather than a glob dependency, matching what the React extractor already does
 * in its own `walkSourceFiles`: the only patterns this package needs are "every `.ts` under a
 * root" and "these few named files", neither of which is worth a dependency or a Node-version
 * floor.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Directories never worth descending into.
 *
 * `dist`/`out` matter for correctness, not just speed: a built copy of a component would be found
 * and parsed as a second, near-identical component, so the manifest would report every component
 * twice for anyone who has run a build.
 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'build', '.git', '.angular', '.cache', 'coverage',
]);

/**
 * Every file under `root` (recursively) whose path satisfies `matches`, as paths RELATIVE to
 * `root` with `/` separators — the same shape `globSync(pattern, { cwd: root })` returned, so
 * callers are unchanged.
 *
 * An unreadable directory is skipped rather than thrown: a scan of someone's source tree should
 * not die on one permission-denied subdirectory, and the alternative (crash) loses every component
 * that was already found.
 */
export function findFiles(root: string, matches: (relativePath: string) => boolean): string[] {
  const found: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && matches(rel)) {
        found.push(rel);
      }
    }
  };

  walk(root, '');
  // Sorted, because `readdirSync` order is filesystem-dependent and the manifest is meant to be
  // diffable: an unsorted walk would reorder `components` between machines for no reason.
  return found.sort();
}
