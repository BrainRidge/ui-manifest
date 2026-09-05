/**
 * Detect how a React app is SERVED: its router `basename`, and whether it uses hash routing.
 *
 * The same two facts Angular's extractor detects, and they matter for the same reason — a manifest
 * that reports the bare route config describes URLs the app never produces, and nothing errors.
 * Every route simply fails to match, which is indistinguishable from an app that has few of them.
 *
 * Both live where the router is constructed, which the route parser has already found: this reuses
 * that pass's source files rather than globbing again, and looks only inside files that actually
 * import react-router. A sweep of every file would eventually find `basename` in an unrelated
 * variable and report it with `confidence: "detected"` — a false positive is worse than a miss,
 * because a miss defaults and says so.
 */
import ts from 'typescript';
import type { AppIdentity, RouterMode } from '@ui-manifest-json/core';

export interface AppIdentityOverrides {
  baseHref?: string;
  routerMode?: RouterMode;
}

/** Router constructors that put the whole route after a `#`. */
const HASH_ROUTERS = new Set(['HashRouter', 'createHashRouter']);

/** Every router constructor that accepts a `basename`. */
const BASENAME_HOSTS = new Set([
  'BrowserRouter', 'HashRouter', 'MemoryRouter',
  'createBrowserRouter', 'createHashRouter', 'createMemoryRouter',
]);

function normaliseBaseHref(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

/** The identifier a JSX element or call expression names, ignoring any namespace qualifier. */
function calleeName(node: ts.Node): string | undefined {
  if (ts.isJsxOpeningLikeElement(node)) {
    const tag = node.tagName;
    if (ts.isIdentifier(tag)) return tag.text;
    if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
    return undefined;
  }
  if (ts.isCallExpression(node)) {
    const target = node.expression;
    if (ts.isIdentifier(target)) return target.text;
    if (ts.isPropertyAccessExpression(target)) return target.name.text;
  }
  return undefined;
}

/** `<Router basename="/portal">` — string literal only; an expression is not statically knowable. */
function basenameFromJsx(node: ts.JsxOpeningLikeElement): string | undefined {
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'basename') continue;
    const init = attr.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    // `basename={BASE}` — resolvable only with a type checker, which this package does not load.
    return undefined;
  }
  return undefined;
}

/** `createBrowserRouter(routes, { basename: '/portal' })`. */
function basenameFromCall(node: ts.CallExpression): string | undefined {
  for (const arg of node.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      if (prop.name.getText() !== 'basename') continue;
      if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
      return undefined;
    }
  }
  return undefined;
}

export interface DetectAppIdentityOptions {
  /** The same `(filePath, sourceFile)` pairs the route parser walked. */
  files: Iterable<readonly [string, ts.SourceFile]>;
  overrides?: AppIdentityOverrides;
}

export function detectAppIdentity(options: DetectAppIdentityOptions): AppIdentity {
  const { files, overrides = {} } = options;

  let baseHref: string | undefined;
  let routerMode: RouterMode | undefined;
  let detectedAnything = false;

  for (const [, sourceFile] of files) {
    const visit = (node: ts.Node): void => {
      const name = calleeName(node);
      if (name) {
        if (HASH_ROUTERS.has(name) && routerMode === undefined) {
          routerMode = 'hash';
          detectedAnything = true;
        }
        if (BASENAME_HOSTS.has(name) && baseHref === undefined) {
          const found = ts.isJsxOpeningLikeElement(node)
            ? basenameFromJsx(node)
            : ts.isCallExpression(node)
              ? basenameFromCall(node)
              : undefined;
          if (found !== undefined) {
            baseHref = normaliseBaseHref(found);
            detectedAnything = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (baseHref !== undefined && routerMode !== undefined) break;
  }

  const configured = overrides.baseHref !== undefined || overrides.routerMode !== undefined;
  return {
    baseHref: overrides.baseHref !== undefined
      ? normaliseBaseHref(overrides.baseHref)
      : baseHref ?? '/',
    routerMode: overrides.routerMode ?? routerMode ?? 'path',
    confidence: configured ? 'configured' : detectedAnything ? 'detected' : 'default',
  };
}
