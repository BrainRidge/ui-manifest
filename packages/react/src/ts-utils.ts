import ts from 'typescript';

/** The three JSX node kinds that can stand in for "this expression renders markup". */
export type JsxLike = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

export function isJsxLike(node: ts.Node): node is JsxLike {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

export function unwrapParens(expr: ts.Expression): ts.Expression {
  let current: ts.Expression = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

export function isNullishLiteral(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}

export function isUpperFirst(name: string): boolean {
  return /^[A-Z]/.test(name);
}

export function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return ts.getModifiers(node)?.some(m => m.kind === kind) ?? false;
}

/** `PropTypes.string` -> "string"; `React.forwardRef` -> "forwardRef"; plain identifier -> itself. */
export function getCalleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** Does a declared return-type annotation's raw text look like a React render return type? */
export function declaredTypeTextIsJsx(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): boolean {
  const text = typeNode.getText(sourceFile);
  return /\b(JSX\.Element|ReactNode|ReactElement)\b/.test(text);
}

/**
 * Walk every reachable `return` statement in a function-like body (including through
 * ternaries, if/else branches, nested blocks/switches — but NOT into nested function/class
 * scopes, which have their own returns) and collect every JSX-shaped value found. Also handles
 * arrow functions with a concise (non-block) expression body, itself possibly a ternary.
 *
 * Order is source order; callers that want "the" primary render output for DOM-building
 * conventionally take the LAST entry (typical pattern: early guard returns first, main render
 * last).
 */
export function collectReturnedJsx(body: ts.ConciseBody): JsxLike[] {
  const found: JsxLike[] = [];

  function visitExpr(expr: ts.Expression): void {
    const u = unwrapParens(expr);
    if (isJsxLike(u)) {
      found.push(u);
      return;
    }
    if (ts.isConditionalExpression(u)) {
      visitExpr(u.whenTrue);
      visitExpr(u.whenFalse);
    }
  }

  function isFunctionLikeNode(node: ts.Node): boolean {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    );
  }

  function visitStatement(node: ts.Node): void {
    if (ts.isReturnStatement(node)) {
      if (node.expression) visitExpr(node.expression);
      return;
    }
    if (isFunctionLikeNode(node)) return; // don't descend into a nested scope's own returns
    ts.forEachChild(node, visitStatement);
  }

  if (ts.isBlock(body)) {
    visitStatement(body);
  } else {
    visitExpr(body);
  }

  return found;
}

export interface ImportBinding {
  moduleSpecifier: string;
  /** Original exported name at the target module: for named imports, `propertyName ?? name`
   *  (so a renamed `import { Foo as Bar }` resolves back to "Foo"); for default imports, the
   *  literal string "default". Namespace imports (`import * as NS from '...'`) aren't resolved
   *  here — a namespace member access as a JSX tag (`<NS.Something/>`) isn't a plain identifier
   *  local name to begin with. */
  exportName: string;
}

/** Find the import declaration in `sourceFile` that binds the local name `localName`, e.g. given
 *  `import { UserCard } from './UserCard'`, `findImportBinding(sf, 'UserCard')` returns
 *  `{ moduleSpecifier: './UserCard', exportName: 'UserCard' }`. */
export function findImportBinding(sourceFile: ts.SourceFile, localName: string): ImportBinding | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const moduleSpecifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;

    if (clause.name && clause.name.text === localName) {
      return { moduleSpecifier, exportName: 'default' };
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (el.name.text === localName) {
          return { moduleSpecifier, exportName: (el.propertyName ?? el.name).text };
        }
      }
    }
  }
  return undefined;
}

/** Unwrap up to `maxLevels` of `forwardRef(...)`/`memo(...)` call-wrapping. */
export function unwrapWrapperCalls(expr: ts.Expression, maxLevels = 2): ts.Expression {
  let current = expr;
  let levels = 0;
  while (levels < maxLevels && ts.isCallExpression(current)) {
    const name = getCalleeName(current.expression);
    if ((name === 'forwardRef' || name === 'memo') && current.arguments.length > 0) {
      current = current.arguments[0];
      levels++;
    } else {
      break;
    }
  }
  return current;
}
