/**
 * Where in the repository a thing is declared.
 *
 * v2 emitted routes, components and elements but never said *where they came from*, so every
 * "where is this declared?" answer a consumer could give was "somewhere in this file" — and for a
 * 400-line template that is not an answer, it is a re-read. Line numbers are the single biggest
 * thing this block adds, and they cost nothing to produce: Angular's `parseTemplate()` and the
 * TypeScript AST both carry positions on every node already.
 *
 * `blobOid` is the quietly valuable field. A git blob sha survives a rename, so a pointer stays
 * resolvable after a refactor that a path alone would strand. Absent until the extractor is asked
 * to shell out to git per file, which it is not today.
 */
export interface SourcePointer {
  /** Repo-relative, forward slashes, no `..` segment. Relative to the repository root — NOT to
   *  `repo.appRoot` — so a consumer can hand it to a repository API without re-joining anything. */
  path: string;
  /** A class, method or guard name. An identifier, never free text. */
  symbol?: string;
  /** 1-based, like an editor shows and unlike every parser that produces it. */
  startLine?: number;
  endLine?: number;
  blobOid?: string;
}
