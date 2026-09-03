/**
 * `@ui-manifest/cli` is primarily a `bin` package (see `cli.ts`) — this library entry point just
 * exposes the detection/decision logic in case another tool wants to embed the same "which
 * extractor is installed" behavior programmatically instead of shelling out.
 */
export { chooseFramework, detectExtractors } from './detect.js';
export type { ChosenExtractor, Framework } from './detect.js';
