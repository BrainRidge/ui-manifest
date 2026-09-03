import ts from 'typescript';

/** Parse a small inline JSX/TSX source string for a unit test — syntactic only, matching how the
 *  real extractor parses files (see `src/index.ts`'s `scriptKindForFile`). */
export function createSourceFile(src: string, fileName = 'test.tsx'): ts.SourceFile {
  const kind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
}
