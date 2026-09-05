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
  baseHref?: string;
  routerMode?: 'path' | 'hash';
  coverage?: 'full' | 'partial';
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
      case '--base-href':
        args.baseHref = argv[++i];
        break;
      case '--router-mode': {
        const mode = argv[++i];
        if (mode !== 'path' && mode !== 'hash') {
          throw new Error(`--router-mode must be "path" or "hash" (got ${JSON.stringify(mode)})`);
        }
        args.routerMode = mode;
        break;
      }
      case '--coverage': {
        const coverage = argv[++i];
        if (coverage !== 'full' && coverage !== 'partial') {
          throw new Error(`--coverage must be "full" or "partial" (got ${JSON.stringify(coverage)})`);
        }
        args.coverage = coverage;
        break;
      }
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
    baseHref: args.baseHref,
    routerMode: args.routerMode,
    coverage: args.coverage,
  });
  // stderr, not `diagnostics`: this is advice for the person running the command, not a statement
  // about the manifest's completeness. Piping stdout to a file leaves it visible; a consumer
  // reading the artifact never sees it.
  if (manifest.app.confidence === 'default') {
    process.stderr.write(
      'note: no <base href>, APP_BASE_HREF provider or hash-routing setup found — assuming the app ' +
      'is served from "/" with path routing. If it is not, every route in this manifest will fail ' +
      'to match a real URL; pass --base-href and/or --router-mode.\n',
    );
  }

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
