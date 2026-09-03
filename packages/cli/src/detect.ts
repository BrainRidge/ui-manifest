import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Framework = 'angular' | 'react';

const PACKAGE_NAMES: Record<Framework, string> = {
  angular: '@ui-manifest/angular',
  react: '@ui-manifest/react',
};

/**
 * Resolve one framework's installed package to its built `cli.js`, or undefined if the package
 * isn't installed (or is installed but wasn't built — no `dist/cli.js` — which is treated the
 * same as "not installed" rather than a confusing crash).
 *
 * Deliberately `import.meta.resolve`, not `require.resolve`: every `@ui-manifest/*` package's
 * `exports` map only declares an `"import"` condition (they're pure ESM), so `require.resolve`
 * fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` even though we never intend to actually `require()`
 * the file's contents — we only want its path, to hand to `spawn()` as a separate process. That's
 * exactly what `import.meta.resolve` does, synchronously and unflagged as of Node 20.6 (this
 * package's `engines.node` floor).
 */
function tryResolveCliPath(framework: Framework): string | undefined {
  try {
    const mainUrl = import.meta.resolve(PACKAGE_NAMES[framework]);
    const mainPath = fileURLToPath(mainUrl);
    const cliPath = resolve(dirname(mainPath), 'cli.js');
    return existsSync(cliPath) ? cliPath : undefined;
  } catch {
    return undefined;
  }
}

/** Every installed (and built) extractor found, keyed by framework. */
export function detectExtractors(): Partial<Record<Framework, string>> {
  const found: Partial<Record<Framework, string>> = {};
  for (const framework of Object.keys(PACKAGE_NAMES) as Framework[]) {
    const cliPath = tryResolveCliPath(framework);
    if (cliPath) found[framework] = cliPath;
  }
  return found;
}

export interface ChosenExtractor {
  framework: Framework;
  cliPath: string;
}

/**
 * Pure decision logic, kept separate from `detectExtractors()`'s filesystem probing so it's
 * testable without needing real installed packages: given what's installed and an optional
 * explicit `--framework` request, decide which one to run, or throw a clear, actionable error.
 */
export function chooseFramework(
  found: Partial<Record<Framework, string>>,
  explicitFramework?: string,
): ChosenExtractor {
  const available = Object.keys(found) as Framework[];

  if (explicitFramework) {
    if (explicitFramework !== 'angular' && explicitFramework !== 'react') {
      throw new Error(`--framework must be "angular" or "react", got "${explicitFramework}".`);
    }
    const cliPath = found[explicitFramework];
    if (!cliPath) {
      throw new Error(
        `--framework ${explicitFramework} requested, but ${PACKAGE_NAMES[explicitFramework]} isn't installed. ` +
          `Installed: ${available.length ? available.join(', ') : 'none'}.`,
      );
    }
    return { framework: explicitFramework, cliPath };
  }

  if (available.length === 0) {
    throw new Error(
      'No extractor installed. Run `npm install --save-dev @ui-manifest/angular` (Angular) or ' +
        '`@ui-manifest/react` (React).',
    );
  }
  if (available.length > 1) {
    throw new Error(
      `Multiple extractors installed (${available.join(', ')}) — pass --framework <${available.join('|')}> to choose one.`,
    );
  }
  const framework = available[0]!;
  return { framework, cliPath: found[framework]! };
}
