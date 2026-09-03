/** Configuration accepted by `extract()` and parsed from `cli.ts`'s argv. */
export interface ExtractConfig {
  /** Directory (repo-relative or absolute) to scan for source files. Default: "src". */
  dir: string;
  /**
   * Glob-ish override for which files are considered when hunting for react-router-dom route
   * setups. When omitted, every scanned `.ts`/`.tsx`/`.jsx` file under `dir` is a candidate (a
   * file only actually contributes routes if it imports from `react-router-dom` — see
   * route-parser/index.ts). This field exists so a large app can narrow the search instead of
   * parsing every file's imports.
   */
  routesGlob?: string;
  /** Also emit `ComponentNode.dom` (JSX -> DomNode trees) for every detected component. */
  withDom: boolean;
  /** Also emit `UiManifest.dependencyGraph` (requires `withDom`, resolved automatically). */
  dependencyGraph: boolean;
  /** Emit a diagnostics entry for every anonymous default-exported component skipped. */
  warnUnnamed: boolean;
}

export const DEFAULT_CONFIG: ExtractConfig = {
  dir: 'src',
  withDom: false,
  dependencyGraph: false,
  warnUnnamed: false,
};

export function resolveConfig(partial: Partial<ExtractConfig> = {}): ExtractConfig {
  const config: ExtractConfig = { ...DEFAULT_CONFIG, ...partial };
  // Building the dependency graph requires walking `dom`, so turning it on implies `withDom`
  // even if the caller forgot to also pass --with-dom.
  if (config.dependencyGraph) {
    config.withDom = true;
  }
  return config;
}
