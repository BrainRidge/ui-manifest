import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { ComponentNode, PropertyBinding, SourcePointer } from '@ui-manifest-json/core';
import type { AngularExtractConfig } from './config.js';
import { findFiles } from './find-files.js';
import { parseComponentDom, resolveTemplateSource } from './dom-parser.js';
import type { TemplateOrigin } from './dom-parser.js';

export interface ComponentParseResult {
  components: ComponentNode[];
  diagnostics: string[];
  /** How many presentational nodes the semantic policy removed, so a consumer can tell that the
   *  tree it is reading is not the DOM. */
  collapsedNodeCount: number;
}

export function parseSourceText(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function parseSourceFile(absPath: string): ts.SourceFile {
  return parseSourceText(readFileSync(absPath, 'utf8'), absPath);
}

/** Exported for route-parser.ts, which needs the identical convention to match a resolved
 *  `loadComponent`/`loadChildren` import target's file path against `ComponentNode.filePath`. */
export function toRepoRelative(absPath: string, cwd: string): string {
  return relative(cwd, absPath).split('\\').join('/');
}

function findClassDecorator(classNode: ts.ClassDeclaration, name: string): ts.Decorator | undefined {
  const decorators = ts.canHaveDecorators(classNode) ? ts.getDecorators(classNode) : undefined;
  if (!decorators) return undefined;
  return decorators.find(d => {
    const expr = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    return ts.isIdentifier(expr) && expr.text === name;
  });
}

/** Shared by route-parser.ts too: pulls `{key: value, ...}` object-literal properties into a
 *  Map keyed by property name, for both `@Component({...})`-style decorator args and route
 *  object literals. */
export function objectLiteralProps(objLiteral: ts.Expression | undefined): Map<string, ts.Expression> {
  const map = new Map<string, ts.Expression>();
  if (!objLiteral || !ts.isObjectLiteralExpression(objLiteral)) return map;
  for (const prop of objLiteral.properties) {
    if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      map.set(prop.name.text, prop.initializer);
    }
  }
  return map;
}

function findMemberDecorator(member: ts.PropertyDeclaration, name: string): ts.Decorator | undefined {
  const decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
  return decorators?.find(d => {
    const expr = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    return ts.isIdentifier(expr) && expr.text === name;
  });
}

async function extractComponent(
  classNode: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  absPath: string,
  config: AngularExtractConfig,
  diagnostics: string[],
  collapsedNodes: { count: number } = { count: 0 },
): Promise<ComponentNode | null> {
  const decorator = findClassDecorator(classNode, 'Component');
  if (!decorator || !ts.isCallExpression(decorator.expression)) return null;
  const args = decorator.expression.arguments;
  const props = objectLiteralProps(args[0]);

  const selectorNode = props.get('selector');
  const selector = selectorNode && ts.isStringLiteralLike(selectorNode) ? selectorNode.text : undefined;

  const standaloneNode = props.get('standalone');
  const standalone = standaloneNode ? standaloneNode.kind !== ts.SyntaxKind.FalseKeyword : true;

  let templateUrl: string | undefined;
  let inlineTemplate = false;
  const templateUrlNode = props.get('templateUrl');
  const templateNode = props.get('template');
  if (templateUrlNode && ts.isStringLiteralLike(templateUrlNode)) {
    templateUrl = templateUrlNode.text;
  } else if (templateNode) {
    inlineTemplate = true;
  }

  const styleUrls: string[] = [];
  const styleUrlNode = props.get('styleUrl');
  const styleUrlsNode = props.get('styleUrls');
  if (styleUrlNode && ts.isStringLiteralLike(styleUrlNode)) {
    styleUrls.push(styleUrlNode.text);
  } else if (styleUrlsNode && ts.isArrayLiteralExpression(styleUrlsNode)) {
    for (const el of styleUrlsNode.elements) {
      if (ts.isStringLiteralLike(el)) styleUrls.push(el.text);
    }
  }

  const inputs: PropertyBinding[] = [];
  const outputs: PropertyBinding[] = [];

  for (const member of classNode.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name) continue;
    const propName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sourceFile);
    const type = member.type ? member.type.getText(sourceFile).trim() : undefined;

    const inputDecorator = findMemberDecorator(member, 'Input');
    const outputDecorator = findMemberDecorator(member, 'Output');

    if (inputDecorator) {
      let alias: string | undefined;
      let required = false;
      if (ts.isCallExpression(inputDecorator.expression)) {
        const arg = inputDecorator.expression.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) alias = arg.text;
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const p = objectLiteralProps(arg);
          const req = p.get('required');
          required = !!req && req.kind === ts.SyntaxKind.TrueKeyword;
          const al = p.get('alias');
          if (al && ts.isStringLiteralLike(al)) alias = al.text;
        }
      }
      inputs.push({
        name: propName,
        ...(alias ? { alias } : {}),
        ...(type ? { type } : {}),
        kind: 'decorator',
        ...(required ? { required } : {}),
      });
      continue;
    }
    if (outputDecorator) {
      let alias: string | undefined;
      if (ts.isCallExpression(outputDecorator.expression)) {
        const arg = outputDecorator.expression.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) alias = arg.text;
      }
      outputs.push({
        name: propName,
        ...(alias ? { alias } : {}),
        ...(type ? { type } : {}),
        kind: 'decorator',
      });
      continue;
    }

    if (member.initializer && ts.isCallExpression(member.initializer)) {
      const callee = member.initializer.expression;
      let calleeText: string | undefined;
      let required = false;
      if (ts.isIdentifier(callee)) {
        calleeText = callee.text;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ts.isIdentifier(callee.name)
      ) {
        calleeText = callee.expression.text;
        required = callee.name.text === 'required';
      }
      const typeArgs = member.initializer.typeArguments?.map(t => t.getText(sourceFile).trim());
      const signalType = typeArgs?.length ? typeArgs.join(', ') : type;
      if (calleeText === 'input') {
        inputs.push({ name: propName, ...(signalType ? { type: signalType } : {}), kind: 'signal', ...(required ? { required } : {}) });
      } else if (calleeText === 'output') {
        outputs.push({ name: propName, ...(signalType ? { type: signalType } : {}), kind: 'signal' });
      }
    }
  }

  inputs.sort((a, b) => a.name.localeCompare(b.name));
  outputs.sort((a, b) => a.name.localeCompare(b.name));

  const filePath = toRepoRelative(absPath, config.cwd);
  const classStart = sourceFile.getLineAndCharacterOfPosition(classNode.getStart(sourceFile));
  const classEnd = sourceFile.getLineAndCharacterOfPosition(classNode.getEnd());

  const result: ComponentNode = {
    filePath,
    source: {
      path: filePath,
      ...(classNode.name?.text ? { symbol: classNode.name.text } : {}),
      startLine: classStart.line + 1,
      endLine: classEnd.line + 1,
    },
    className: classNode.name?.text ?? '(anonymous)',
    ...(selector ? { selector } : {}),
    standalone,
    ...(templateUrl ? { templateUrl } : {}),
    ...(inlineTemplate ? { inlineTemplate } : {}),
    styleUrls,
    inputs,
    outputs,
  };

  if (config.withDom && (templateUrl || inlineTemplate)) {
    const inlineTemplateText = templateNode && ts.isStringLiteralLike(templateNode) ? templateNode.text : undefined;
    const templateSource = resolveTemplateSource(templateUrl, inlineTemplateText, absPath);
    if (templateSource != null) {
      const urlForErrors = templateUrl ?? result.filePath;
      // An element's pointer must name the file its TEXT is in, which for a `templateUrl` is a
      // different file from the component's. And an inline template's lines are numbered from the
      // start of the literal, not the start of the `.ts` — so without this offset every pointer
      // into an inline template lands in the import block, confidently.
      const origin: TemplateOrigin = templateUrl
        ? { path: toRepoRelative(resolve(dirname(absPath), templateUrl), config.cwd), lineOffset: 0 }
        : {
            path: filePath,
            lineOffset: templateNode
              ? sourceFile.getLineAndCharacterOfPosition(templateNode.getStart(sourceFile)).line
              : 0,
          };
      const templateEnd = templateNode
        ? sourceFile.getLineAndCharacterOfPosition(templateNode.getEnd()).line + 1
        : undefined;
      result.template = {
        source: {
          path: origin.path,
          startLine: origin.lineOffset + 1,
          ...(templateUrl ? {} : { endLine: templateEnd }),
        },
        inline: !templateUrl,
      };
      const parsed = await parseComponentDom(templateSource, urlForErrors, origin);
      if (parsed.ok) {
        result.dom = parsed.dom;
        collapsedNodes.count += parsed.collapsed;
        diagnostics.push(...parsed.diagnostics);
      } else {
        diagnostics.push(`template parse error in ${result.filePath}: ${parsed.error}`);
      }
    } else {
      diagnostics.push(`could not resolve template source for ${result.filePath}`);
    }
  }

  return result;
}

/** Parse every `@Component`-decorated class out of a single already-in-memory TS source string.
 *  Exported (in addition to the file-driven {@link collectComponents}) so unit tests can feed
 *  small inline source strings without touching disk. */
export async function extractComponentsFromSource(
  sourceText: string,
  absPath: string,
  config: AngularExtractConfig,
  diagnostics: string[],
  collapsedNodes: { count: number } = { count: 0 },
): Promise<ComponentNode[]> {
  const sourceFile = parseSourceText(sourceText, absPath);
  const classNodes: ts.ClassDeclaration[] = [];
  ts.forEachChild(sourceFile, node => {
    if (ts.isClassDeclaration(node) && node.name) classNodes.push(node);
  });
  const components: ComponentNode[] = [];
  for (const classNode of classNodes) {
    const component = await extractComponent(classNode, sourceFile, absPath, config, diagnostics, collapsedNodes);
    if (component) components.push(component);
  }
  return components;
}

/** A spec's `@Component` test host is a fixture, not part of the app. This was dead weight next to
 *  the old `*.component.ts` filter — a path cannot end in both — and only becomes load-bearing now
 *  that discovery is filename-agnostic. */
const TEST_FILE_RE = /\.(test|spec)\.ts$/;

/**
 * Whether a file is worth opening in the search for components.
 *
 * Deliberately NOT `*.component.ts`. That is an Angular *style guide* suggestion, never a compiler
 * rule, and v20's CLI stopped following it: `ng generate component book-list` now writes
 * `book-list.ts` exporting `class BookList`. Filtering on the old convention matched nothing
 * whatsoever on a v20-scaffolded app — and because the routes pass reads `app.routes.ts` by name and
 * was unaffected, the result was a confident, fully-populated `routes` array beside an empty
 * `components`, `routeTrees` and `dependencyGraph`. Silence, not a crash, under `coverage: "full"`.
 *
 * The decorator is the real filter: `extractComponentsFromSource` discards every class that has no
 * `@Component`, so this predicate only decides which files get opened, never what counts as a
 * component. Widening it cannot invent components; narrowing it can only lose them.
 *
 * This is also what the React extractor's `walkSourceFiles` has always done — take every source
 * file, drop declarations and tests, let the detector decide.
 */
function couldHoldComponent(relativePath: string): boolean {
  return relativePath.endsWith('.ts')
    && !relativePath.endsWith('.d.ts')
    && !TEST_FILE_RE.test(relativePath);
}

/** Walk `config.targetDir` for every file that could hold a component (see
 *  {@link couldHoldComponent}) and extract each `@Component`-decorated class into a
 *  `ComponentNode`. */
export async function collectComponents(config: AngularExtractConfig): Promise<ComponentParseResult> {
  const files = findFiles(config.targetDir, couldHoldComponent);
  const diagnostics: string[] = [];
  const components: ComponentNode[] = [];
  const collapsedNodes = { count: 0 };
  for (const rel of files) {
    const absPath = resolve(config.targetDir, rel);
    const text = readFileSync(absPath, 'utf8');
    // Cheap substring gate ahead of the AST. Discovery now opens every service, model and barrel
    // file in the app, and `ts.createSourceFile` on all of them is the one real cost of that;
    // a file whose text contains no `@Component` at all cannot yield one. Deliberately imprecise:
    // a hit inside a comment or string buys a single parse that then returns nothing, which is
    // exactly what the old filename filter would have done with the same file.
    if (!text.includes('@Component')) continue;
    components.push(...(await extractComponentsFromSource(text, absPath, config, diagnostics, collapsedNodes)));
  }
  components.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return { components, diagnostics, collapsedNodeCount: collapsedNodes.count };
}
