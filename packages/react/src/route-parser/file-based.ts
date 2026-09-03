/**
 * Next.js-style file-based routing (the `app/`/`pages/` directory convention, where a file's
 * location in the tree IS its route) is an explicit, deliberate gap in this pass — see the
 * `# React extraction limits` note at the top of `index.ts`. `routingPattern: 'file-based'` is
 * reserved on the `ReactRoutingPattern` type so a future pass can wire this in without a schema
 * change, but no directory-walk route inference happens here. This stub exists purely so the
 * dispatcher's type surface is honest about that reserved value instead of pretending to
 * implement it; it must never be silently invoked as if it did something.
 */
export function parseFileBasedRoutes(): never {
  throw new Error('file-based routing not yet implemented');
}
