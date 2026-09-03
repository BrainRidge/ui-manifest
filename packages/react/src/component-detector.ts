import ts from 'typescript';
import {
  collectReturnedJsx,
  declaredTypeTextIsJsx,
  getCalleeName,
  hasModifier,
  isUpperFirst,
  unwrapWrapperCalls,
  type JsxLike,
} from './ts-utils.js';

export type ComponentKind = 'function' | 'class';

/** A class or class-expression node — both share the shape this file needs. */
export type ClassLike = ts.ClassDeclaration | ts.ClassExpression;
export type FunctionLike = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

/**
 * A component found in one source file, still carrying live AST references so downstream
 * passes (props-parser, jsx-dom-parser) can read the exact nodes they need without re-walking
 * the file.
 */
export interface DetectedComponent {
  /** The identifier the component is bound to: a function/class name, or a `const` binding name. */
  name: string;
  kind: ComponentKind;
  isDefaultExport: boolean;
  /** Function components (including forwardRef/memo-unwrapped and class-expression-unwrapped). */
  fn?: FunctionLike;
  /** Class components. */
  classDecl?: ClassLike;
  /** Present only when `fn` came from `const Name: T = ...`, so props-parser can read `T`. */
  variableDecl?: ts.VariableDeclaration;
  /** The JSX this component renders, chosen as described on `collectReturnedJsx`. Absent when
   *  detection matched only via a declared JSX-shaped return type, with no literal JSX return
   *  found to build a `dom` tree from. */
  primaryJsx?: JsxLike;
}

export interface ComponentDetectionResult {
  components: DetectedComponent[];
  /** Anonymous default-exported components found but skipped (no uppercase binding to key them
   *  by). Always counted, regardless of `--warn-unnamed` — the caller decides whether to surface
   *  it as a diagnostic. */
  unnamedSkippedCount: number;
}

function findRenderMethod(members: ts.NodeArray<ts.ClassElement>): ts.MethodDeclaration | undefined {
  return members.find(
    (m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'render',
  );
}

function isReactClassComponentLike(node: ClassLike): boolean {
  const heritage = node.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
  const base = heritage?.types[0]?.expression;
  if (!base) return false;
  const name = getCalleeName(base);
  return name === 'Component' || name === 'PureComponent';
}

function primaryJsxForClass(node: ClassLike): { detected: boolean; primaryJsx?: JsxLike } {
  const render = findRenderMethod(node.members);
  if (!render) return { detected: false };
  const returned = render.body ? collectReturnedJsx(render.body) : [];
  if (returned.length > 0) return { detected: true, primaryJsx: returned[returned.length - 1] };
  if (render.type && declaredTypeTextIsJsx(render.type, node.getSourceFile())) return { detected: true };
  return { detected: false };
}

function analyzeFunctionLike(fn: FunctionLike): { detected: boolean; primaryJsx?: JsxLike } {
  if (!fn.body) return { detected: false };
  const returned = collectReturnedJsx(fn.body);
  if (returned.length > 0) return { detected: true, primaryJsx: returned[returned.length - 1] };
  if (fn.type && declaredTypeTextIsJsx(fn.type, fn.getSourceFile())) return { detected: true };
  return { detected: false };
}

/**
 * Find every React component defined at the top level of a source file: uppercase-bound
 * function/arrow-function components whose body provably returns JSX (or whose declared return
 * type says so), class components extending React.Component/Component, both optionally wrapped
 * in one or two levels of forwardRef/memo, plus `export default <anonymous-or-named>` forms of
 * all of the above.
 *
 * Only top-level declarations are considered — this is a syntactic, single-file pass (no type
 * checker), matching the Angular extractor's posture.
 */
export function detectComponents(sourceFile: ts.SourceFile): ComponentDetectionResult {
  const components: DetectedComponent[] = [];
  let unnamedSkippedCount = 0;

  for (const stmt of sourceFile.statements) {
    // function Foo(...) {...}
    if (ts.isFunctionDeclaration(stmt)) {
      const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
      if (!stmt.name) {
        // export default function (...) {...} — anonymous. Only worth counting if it actually
        // looks like it renders something; a stray anonymous default-exported non-component
        // function would just be noise.
        const { detected } = analyzeFunctionLike(stmt);
        if (isDefault && detected) unnamedSkippedCount++;
        continue;
      }
      if (!isUpperFirst(stmt.name.text)) continue;
      const { detected, primaryJsx } = analyzeFunctionLike(stmt);
      if (detected) {
        components.push({ name: stmt.name.text, kind: 'function', isDefaultExport: isDefault, fn: stmt, primaryJsx });
      }
      continue;
    }

    // class Foo extends Component {...}
    if (ts.isClassDeclaration(stmt)) {
      const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
      if (!isReactClassComponentLike(stmt)) continue;
      if (!stmt.name) {
        unnamedSkippedCount++;
        continue;
      }
      if (!isUpperFirst(stmt.name.text)) continue;
      const { detected, primaryJsx } = primaryJsxForClass(stmt);
      if (detected) {
        components.push({ name: stmt.name.text, kind: 'class', isDefaultExport: isDefault, classDecl: stmt, primaryJsx });
      }
      continue;
    }

    // const Foo = (...) => {...}  /  const Foo: React.FC<Props> = (...) => {...}
    // (also handles forwardRef(...)/memo(...)-wrapped initializers)
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const unwrapped = unwrapWrapperCalls(decl.initializer);
        if (!ts.isArrowFunction(unwrapped) && !ts.isFunctionExpression(unwrapped)) continue;
        if (!isUpperFirst(decl.name.text)) continue;
        const { detected, primaryJsx } = analyzeFunctionLike(unwrapped);
        if (detected) {
          components.push({
            name: decl.name.text,
            kind: 'function',
            isDefaultExport: false,
            fn: unwrapped,
            variableDecl: decl,
            primaryJsx,
          });
        }
      }
      continue;
    }

    // export default <expr>;  where <expr> is an inline (possibly anonymous) function/class,
    // optionally forwardRef/memo-wrapped. `export default Identifier;` referring to an earlier
    // top-level declaration is intentionally not re-handled here — that declaration was already
    // picked up above (its own isDefaultExport stays false, which is a known, documented
    // simplification: we don't retroactively flip it for a separate `export default X` statement).
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const unwrapped = unwrapWrapperCalls(stmt.expression);
      if (ts.isIdentifier(unwrapped)) continue;

      if (ts.isClassExpression(unwrapped)) {
        if (!isReactClassComponentLike(unwrapped)) continue;
        const name = unwrapped.name?.text;
        if (!name || !isUpperFirst(name)) {
          unnamedSkippedCount++;
          continue;
        }
        const { detected, primaryJsx } = primaryJsxForClass(unwrapped);
        if (detected) {
          components.push({ name, kind: 'class', isDefaultExport: true, classDecl: unwrapped, primaryJsx });
        }
        continue;
      }

      if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
        const name = ts.isFunctionExpression(unwrapped) ? unwrapped.name?.text : undefined;
        const { detected, primaryJsx } = analyzeFunctionLike(unwrapped);
        if (!name || !isUpperFirst(name)) {
          if (detected) unnamedSkippedCount++;
          continue;
        }
        if (detected) {
          components.push({ name, kind: 'function', isDefaultExport: true, fn: unwrapped, primaryJsx });
        }
        continue;
      }
    }
  }

  // Second pass: `export default X;` referring to an earlier top-level declaration (the common
  // `function Foo() {...}\nexport default Foo;` / `const Foo = () => {...}\nexport default Foo;`
  // shape) doesn't carry a `default` modifier on the declaration itself, so the first pass above
  // leaves that component's `isDefaultExport` at its declaration-site default (false). Flip it
  // here — resolve.ts's default-export indexing (see resolve.ts's `buildComponentIndex`) depends
  // on this being accurate for `import X from './thatFile'` to resolve correctly.
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue;
    const unwrapped = unwrapWrapperCalls(stmt.expression);
    if (!ts.isIdentifier(unwrapped)) continue;
    const match = components.find(c => c.name === unwrapped.text);
    if (match) match.isDefaultExport = true;
  }

  return { components, unnamedSkippedCount };
}
