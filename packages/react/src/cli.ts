#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { extract } from './index.js';
import type { ExtractConfig } from './config.js';

interface CliOptions extends Partial<ExtractConfig> {
  out?: string;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: ui-manifest-react [options]',
      '',
      'Options:',
      '  --dir <path>          Directory to scan (default: "src")',
      '  --routes-glob <glob>  Narrow which files are checked for react-router-dom routing setups',
      '  --with-dom            Also emit ComponentNode.dom (JSX -> DomNode trees)',
      '  --dependency-graph    Also emit UiManifest.dependencyGraph (implies --with-dom)',
      '  --warn-unnamed        Emit a diagnostic for each skipped anonymous default export',
      '  --base-href <path>    Override the detected router basename (default: detected, else "/")',
      '  --router-mode <mode>  "path" or "hash" (default: detected, else "path")',
      '  --coverage <kind>     "full" or "partial" — whether a missing route means deleted',
      '  --out <path>          Write JSON to a file instead of stdout',
      '  -h, --help            Show this help text',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dir':
        options.dir = argv[++i];
        break;
      case '--routes-glob':
        options.routesGlob = argv[++i];
        break;
      case '--with-dom':
        options.withDom = true;
        break;
      case '--dependency-graph':
        options.dependencyGraph = true;
        break;
      case '--warn-unnamed':
        options.warnUnnamed = true;
        break;
      case '--base-href':
        options.baseHref = argv[++i];
        break;
      case '--router-mode': {
        const mode = argv[++i];
        if (mode !== 'path' && mode !== 'hash') {
          throw new Error(`--router-mode must be "path" or "hash" (got ${JSON.stringify(mode)})`);
        }
        options.routerMode = mode;
        break;
      }
      case '--coverage': {
        const coverage = argv[++i];
        if (coverage !== 'full' && coverage !== 'partial') {
          throw new Error(`--coverage must be "full" or "partial" (got ${JSON.stringify(coverage)})`);
        }
        options.coverage = coverage;
        break;
      }
      case '--out':
        options.out = argv[++i];
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        process.stderr.write(`Unknown option: ${arg}\n`);
        printUsage();
        process.exit(1);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const { out, ...config } = parseArgs(process.argv.slice(2));
  const manifest = await extract(config);
  const json = JSON.stringify(manifest, null, 2);
  if (out) {
    await writeFile(out, `${json}\n`, 'utf8');
  } else {
    process.stdout.write(`${json}\n`);
  }
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
