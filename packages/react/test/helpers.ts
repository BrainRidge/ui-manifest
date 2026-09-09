import ts from 'typescript';

/** Parse a small inline JSX/TSX source string for a unit test — syntactic only, matching how the
 *  real extractor parses files. Kept a mirror of `src/index.ts`'s `scriptKindForFile` on purpose,
 *  `.js` included: a `.js` test whose ScriptKind said TS would silently fail to parse its own JSX
 *  and prove nothing about how the extractor treats a Babel-compiled app's files. */
export function createSourceFile(src: string, fileName = 'test.tsx'): ts.SourceFile {
  const kind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : fileName.endsWith('.js')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
}
