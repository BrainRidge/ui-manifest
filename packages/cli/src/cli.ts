#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chooseFramework, detectExtractors } from './detect.js';

/**
 * `ui-manifest` is a thin dispatcher: it does not re-implement argv parsing or config-building
 * for either framework (their flag sets genuinely differ — e.g. Angular's `--routes`, React's
 * `--warn-unnamed` — and keeping one shared parser in sync with two independently-evolving
 * packages is exactly the kind of coupling worth avoiding). It only decides WHICH already-working
 * extractor CLI to run, then execs it directly, forwarding every other argument verbatim.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  let explicitFramework: string | undefined;
  const frameworkFlagIndex = argv.indexOf('--framework');
  if (frameworkFlagIndex !== -1) {
    explicitFramework = argv[frameworkFlagIndex + 1];
    argv.splice(frameworkFlagIndex, 2);
  }

  const found = detectExtractors();
  const { cliPath } = chooseFramework(found, explicitFramework);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => resolvePromise(code ?? 1));
  });
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
