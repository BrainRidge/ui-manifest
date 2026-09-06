/**
 * What the extractor could NOT statically resolve.
 *
 * This is not optional bookkeeping. When a consumer sees an element at runtime that no manifest
 * declares, there are two causes — the manifest is stale, or the app injects that DOM — and they
 * need opposite actions. This list is the only thing that tells them apart. Without it, every such
 * finding is undiagnosable and a manifest covering 70% of an app looks complete.
 *
 * `diagnostics[]` is still emitted alongside and still carries the same notices as free text; this
 * is the same information given a shape a consumer can branch on.
 */
export type UncapturableKind =
  | 'dynamicComponentOutlet'
  | 'innerHTML'
  | 'runtimeRoute'
  | 'unresolvedLazyChunk'
  | 'thirdPartyWebComponent'
  | 'iframe'
  | 'dynamicSelector'
  | 'unresolvedApiUrl'
  | 'templateParseError'
  | 'unsupportedTemplateNode';

export interface Uncapturable {
  kind: UncapturableKind;
  /** The component (or route) whose extraction is incomplete because of this. */
  affects?: string;
  /** Free text, for a person. */
  detail?: string;
  source?: import('./source.js').SourcePointer;
}
