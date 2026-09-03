import ts from 'typescript';
import type { DomNode, ElementNode, TemplateNode } from '@ui-manifest-json/core';
import { collectReturnedJsx, isJsxLike, isNullishLiteral, unwrapParens, type JsxLike } from './ts-utils.js';

const EVENT_ATTR_RE = /^on[A-Z]/;

function getTagName(node: ts.JsxElement | ts.JsxSelfClosingElement, sourceFile: ts.SourceFile): string {
  const tagNameNode = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tagNameNode.getText(sourceFile);
}

function getAttributes(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function attributesToPropsAndEvents(
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
): { attrs: Record<string, string>; props: ElementNode['props']; events: ElementNode['events'] } {
  const attrs: Record<string, string> = {};
  const props: ElementNode['props'] = [];
  const events: ElementNode['events'] = [];

  for (const attr of attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      props.push({ name: '...spread', expr: attr.expression.getText(sourceFile) });
      continue;
    }
    // ts.isJsxAttribute(attr) from here on.
    const name = attr.name.getText(sourceFile);
    const initializer = attr.initializer;

    if (!initializer) {
      // Boolean shorthand, e.g. `disabled`.
      attrs[name] = 'true';
      continue;
    }

    if (ts.isStringLiteral(initializer)) {
      attrs[name] = initializer.text;
      continue;
    }

    if (ts.isJsxExpression(initializer)) {
      const exprNode = initializer.expression;
      if (!exprNode) continue; // `{/* comment */}` — nothing to record.
      const exprText = exprNode.getText(sourceFile);
      if (EVENT_ATTR_RE.test(name)) {
        events.push({ name, expr: exprText });
      } else {
        props.push({ name, expr: exprText });
      }
    }
  }

  return { attrs, props, events };
}

function elementToDomNode(node: ts.JsxElement | ts.JsxSelfClosingElement, sourceFile: ts.SourceFile): ElementNode {
  const el = getTagName(node, sourceFile);
  const { attrs, props, events } = attributesToPropsAndEvents(getAttributes(node), sourceFile);
  const children = ts.isJsxElement(node) ? node.children.flatMap(child => jsxChildToDomNodes(child, sourceFile)) : [];
  return { type: 'element', extraction: 'compiler', el, attrs, props, events, children };
}

/** A single JSX-like node (element/self-closing/fragment) -> zero-or-more DomNode. Fragments
 *  splice their children directly instead of emitting a synthetic wrapper node. */
function jsxLikeToDomNodes(node: JsxLike, sourceFile: ts.SourceFile): DomNode[] {
  if (ts.isJsxFragment(node)) {
    return node.children.flatMap(child => jsxChildToDomNodes(child, sourceFile));
  }
  return [elementToDomNode(node, sourceFile)];
}

/** Resolve a `.map()` callback's rendered JSX (arrow with an expression body, or a block body
 *  with a `return` statement), captured once as a template shape rather than per-iteration. */
function callbackRenderedJsx(callback: ts.Expression): JsxLike | undefined {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return undefined;
  if (!callback.body) return undefined;
  if (!ts.isBlock(callback.body)) {
    const u = unwrapParens(callback.body);
    return isJsxLike(u) ? u : undefined;
  }
  const returned = collectReturnedJsx(callback.body);
  return returned[returned.length - 1];
}

function isMapCallReturningJsx(
  expr: ts.CallExpression,
): { arrayExpr: ts.Expression; renderedJsx: JsxLike } | undefined {
  if (!ts.isPropertyAccessExpression(expr.expression) || expr.expression.name.text !== 'map') return undefined;
  const [callback] = expr.arguments;
  if (!callback) return undefined;
  const renderedJsx = callbackRenderedJsx(callback);
  if (!renderedJsx) return undefined;
  return { arrayExpr: expr.expression.expression, renderedJsx };
}

/** A ternary branch: `null`/`undefined` -> no children; JSX -> walked; anything else -> kept as
 *  a plain interpolation rather than silently dropped. */
function ternaryBranchToChildren(expr: ts.Expression, sourceFile: ts.SourceFile): DomNode[] {
  const u = unwrapParens(expr);
  if (isNullishLiteral(u)) return [];
  if (isJsxLike(u)) return jsxLikeToDomNodes(u, sourceFile);
  return [{ type: 'interpolation', extraction: 'compiler', interpolation: u.getText(sourceFile) }];
}

/** Classify a JSX `{expr}` child: ternary / `&&` / `.map()` heuristics, else a plain
 *  interpolation carrying the raw source text. */
function classifyJsxExpression(expr: ts.Expression, sourceFile: ts.SourceFile): DomNode[] {
  const u = unwrapParens(expr);

  if (ts.isConditionalExpression(u)) {
    const consequentUnwrapped = unwrapParens(u.whenTrue);
    const alternateUnwrapped = unwrapParens(u.whenFalse);
    if (isJsxLike(consequentUnwrapped) || isJsxLike(alternateUnwrapped)) {
      const consequentChildren = ternaryBranchToChildren(u.whenTrue, sourceFile);
      const alternateChildren = ternaryBranchToChildren(u.whenFalse, sourceFile);
      const node: TemplateNode = {
        type: 'template',
        structural: 'ternary',
        condition: u.condition.getText(sourceFile),
        extraction: 'heuristic',
        branches: [
          { label: 'consequent', children: consequentChildren },
          { label: 'alternate', children: alternateChildren },
        ],
        children: consequentChildren,
      };
      return [node];
    }
  }

  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const rhs = unwrapParens(u.right);
    if (isJsxLike(rhs)) {
      const node: TemplateNode = {
        type: 'template',
        structural: '&&',
        condition: u.left.getText(sourceFile),
        extraction: 'heuristic',
        children: jsxLikeToDomNodes(rhs, sourceFile),
      };
      return [node];
    }
  }

  if (ts.isCallExpression(u)) {
    const mapMatch = isMapCallReturningJsx(u);
    if (mapMatch) {
      const node: TemplateNode = {
        type: 'template',
        structural: '.map()',
        condition: mapMatch.arrayExpr.getText(sourceFile),
        extraction: 'heuristic',
        children: jsxLikeToDomNodes(mapMatch.renderedJsx, sourceFile),
      };
      return [node];
    }
  }

  // Not a recognized control-flow shape — capture the raw source exactly, no guessing.
  return [{ type: 'interpolation', extraction: 'compiler', interpolation: expr.getText(sourceFile) }];
}

function jsxChildToDomNodes(child: ts.JsxChild, sourceFile: ts.SourceFile): DomNode[] {
  if (ts.isJsxText(child)) {
    const value = child.text.trim();
    if (!value) return [];
    return [{ type: 'text', extraction: 'compiler', value }];
  }
  if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
    return jsxLikeToDomNodes(child, sourceFile);
  }
  if (ts.isJsxFragment(child)) {
    return jsxLikeToDomNodes(child, sourceFile);
  }
  if (ts.isJsxExpression(child)) {
    if (!child.expression) return []; // `{/* comment */}` or `{}`
    if (child.dotDotDotToken) {
      // JSX spread children (`{...children}`) are vanishingly rare and not valid JSX syntax in
      // practice for element children; guard defensively rather than crash.
      return [{ type: 'interpolation', extraction: 'compiler', interpolation: child.getText(sourceFile) }];
    }
    return classifyJsxExpression(child.expression, sourceFile);
  }
  return [];
}

/**
 * Build the `DomNode[]` for a component's rendered output, given the JSX root
 * `component-detector.ts` chose as its primary return value. Mirrors the Angular extractor's
 * template-DOM shape exactly (see packages/core/src/types/dom.ts).
 */
export function buildDom(root: JsxLike | undefined, sourceFile: ts.SourceFile): DomNode[] {
  if (!root) return [];
  return jsxLikeToDomNodes(root, sourceFile);
}
