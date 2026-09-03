#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extract } from './index.js';

interface CliArgs {
  dir?: string;
  routes?: string;
  withDom: boolean;
  dependencyGraph: boolean;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { withDom: false, dependencyGraph: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dir':
        args.dir = argv[++i];
        break;
      case '--routes':
        args.routes = argv[++i];
        break;
      case '--with-dom':
        args.withDom = true;
        break;
      case '--dependency-graph':
        args.dependencyGraph = true;
        break;
      case '--out':
        args.out = argv[++i];
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await extract({
    targetDir: args.dir,
    routesFile: args.routes,
    withDom: args.withDom,
    dependencyGraph: args.dependencyGraph,
  });
  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (args.out && args.out !== '-') {
    writeFileSync(resolve(process.cwd(), args.out), json, 'utf8');
  } else {
    process.stdout.write(json);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
