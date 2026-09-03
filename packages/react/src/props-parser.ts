import ts from 'typescript';
import type { PropDefinition } from '@ui-manifest/core';
import type { DetectedComponent } from './component-detector.js';

const EVENT_HANDLER_RE = /^on[A-Z]/;

function isEventHandlerName(name: string): boolean {
  return EVENT_HANDLER_RE.test(name);
}

function membersToPropDefinitions(
  members: ts.NodeArray<ts.TypeElement>,
  sourceFile: ts.SourceFile,
): PropDefinition[] {
  const props: PropDefinition[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = member.name.getText(sourceFile);
    const required = !member.questionToken;
    const type = member.type?.getText(sourceFile);
    const prop: PropDefinition = { name, required, source: 'ts-type' };
    if (type !== undefined) prop.type = type;
    if (isEventHandlerName(name)) prop.isEventHandler = true;
    props.push(prop);
  }
  return props;
}

/** Resolve a `TypeReferenceNode` (e.g. `Props`) to its local same-file `interface`/`type`
 *  declaration and walk it. Cross-file resolution needs a type checker and is out of scope. */
function resolveLocalTypeReference(typeRefName: string, sourceFile: ts.SourceFile): PropDefinition[] | undefined {
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === typeRefName) {
      return membersToPropDefinitions(stmt.members, sourceFile);
    }
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === typeRefName) {
      if (ts.isTypeLiteralNode(stmt.type)) {
        return membersToPropDefinitions(stmt.type.members, sourceFile);
      }
      return undefined; // e.g. a union/mapped type alias — can't walk members generically
    }
  }
  return undefined;
}

function typeNodeToPropDefinitions(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): PropDefinition[] | undefined {
  if (ts.isTypeLiteralNode(typeNode)) {
    return membersToPropDefinitions(typeNode.members, sourceFile);
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return resolveLocalTypeReference(typeNode.typeName.text, sourceFile);
  }
  return undefined;
}

/** True for a type-reference name of `FC`/`React.FC`/`FunctionComponent`/`React.FunctionComponent`/
 *  `VFC`/`React.VFC` — the generic-argument-carrying component-typing forms. */
function isFcTypeName(typeName: ts.EntityName): boolean {
  const last = ts.isQualifiedName(typeName) ? typeName.right.text : typeName.text;
  return last === 'FC' || last === 'FunctionComponent' || last === 'VFC';
}

function resolvePropsTypeNode(component: DetectedComponent): ts.TypeNode | undefined {
  // 1. TS type: the component function's first parameter's type annotation.
  if (component.fn) {
    const [first] = component.fn.parameters;
    if (first?.type) return first.type;
  }
  // 2. React.FC<Props> / FunctionComponent<Props> on the `const Name: T = ...` annotation.
  const variableType = component.variableDecl?.type;
  if (variableType && ts.isTypeReferenceNode(variableType) && isFcTypeName(variableType.typeName)) {
    const [propsArg] = variableType.typeArguments ?? [];
    if (propsArg) return propsArg;
  }
  // 3. class Foo extends Component<Props, State>
  if (component.classDecl) {
    const heritage = component.classDecl.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    const base = heritage?.types[0];
    const [propsArg] = base?.typeArguments ?? [];
    if (propsArg) return propsArg;
  }
  return undefined;
}

const PROP_TYPES_VALIDATORS = new Set([
  'array',
  'bool',
  'func',
  'number',
  'object',
  'string',
  'symbol',
  'node',
  'element',
  'elementType',
  'instanceOf',
  'oneOf',
  'oneOfType',
  'arrayOf',
  'objectOf',
  'shape',
  'exact',
  'any',
]);

function parsePropTypesValidator(expr: ts.Expression): { type: string; required: boolean } | undefined {
  let current: ts.Expression = expr;
  let required = false;
  if (ts.isPropertyAccessExpression(current) && current.name.text === 'isRequired') {
    required = true;
    current = current.expression;
  }
  const callee = ts.isCallExpression(current) ? current.expression : current;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const validatorName = callee.name.text;
  if (!PROP_TYPES_VALIDATORS.has(validatorName)) return undefined;
  return { type: validatorName, required };
}

/** Find `ComponentName.propTypes = {...}` anywhere in the file and walk it. */
function findPropTypesAssignment(componentName: string, sourceFile: ts.SourceFile): PropDefinition[] | undefined {
  let result: PropDefinition[] | undefined;

  function visit(node: ts.Node): void {
    if (result) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'propTypes' &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === componentName &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      const props: PropDefinition[] = [];
      for (const prop of node.right.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
        if (!name) continue;
        const validator = parsePropTypesValidator(prop.initializer);
        if (!validator) continue;
        const def: PropDefinition = { name, required: validator.required, source: 'prop-types', type: validator.type };
        if (isEventHandlerName(name)) def.isEventHandler = true;
        props.push(def);
      }
      result = props;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

/**
 * Extract `PropDefinition[]` for a detected component, first match wins:
 *   1. TS type (inline type literal, or a local same-file interface/type-alias by name; also
 *      `React.FC<Props>`/`FunctionComponent<Props>`/class `Component<Props, State>` generics).
 *   2. `ComponentName.propTypes = {...}` static assignment.
 *   3. Neither found -> `[]` (never fabricated).
 */
export function extractProps(component: DetectedComponent, sourceFile: ts.SourceFile): PropDefinition[] {
  const typeNode = resolvePropsTypeNode(component);
  if (typeNode) {
    const fromType = typeNodeToPropDefinitions(typeNode, sourceFile);
    if (fromType) return fromType;
  }
  const fromPropTypes = findPropTypesAssignment(component.name, sourceFile);
  if (fromPropTypes) return fromPropTypes;
  return [];
}
