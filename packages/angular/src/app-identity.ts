/**
 * Detect how an Angular app is actually SERVED: its base href and its router mode.
 *
 * These two decide whether a route path corresponds to a URL a browser will ever show. An app
 * configured with `<base href="/portal/">` renders `/portal/dashboard`; one built with
 * `withHashLocation()` renders `/#/dashboard`. A manifest that reports the bare route config is
 * describing neither, and — this is the point — nothing errors. Every route simply fails to match,
 * which looks exactly like an app that has little in it.
 *
 * So the posture here is: detect what is syntactically visible, let the caller override, and when
 * neither applies say so via `confidence: "default"` rather than presenting a convention as a
 * finding. A consumer can then decide whether a defaulted `"/"` is good enough for what it is
 * doing; it could not decide that from a value indistinguishable from a detected one.
 *
 * Syntactic, like the rest of this package: `index.html` is read as text and the router setup is
 * matched in the TypeScript AST. Nothing is executed and no `Program` is loaded.
 */
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { AppIdentity, RouterMode } from '@ui-manifest-json/core';

/** `<base href="...">`, single or double quoted, attribute order-independent. */
const BASE_HREF_TAG = /<base\b[^>]*\bhref\s*=\s*["']([^"']*)["']/i;

/** `{ provide: APP_BASE_HREF, useValue: '/portal/' }` — the runtime alternative to the tag. */
const APP_BASE_HREF_PROVIDER = /APP_BASE_HREF\s*,\s*useValue\s*:\s*["'`]([^"'`]*)["'`]/;

/** Both ways to ask for hash routing: standalone `provideRouter` and the NgModule form. */
const HASH_LOCATION = /\bwithHashLocation\s*\(/;
const USE_HASH = /\buseHash\s*:\s*true\b/;

export interface AppIdentityOverrides {
  baseHref?: string;
  routerMode?: RouterMode;
}

/** Candidate locations for `index.html`, relative to the scanned `src/app`. Ordered by how an
 *  Angular CLI project is actually laid out; the first that exists wins. */
function indexHtmlCandidates(targetDir: string, cwd: string): string[] {
  const src = dirname(targetDir);                  // src/app -> src
  return [
    resolve(src, 'index.html'),
    resolve(cwd, 'src/index.html'),
    resolve(cwd, 'index.html'),
  ];
}

function normaliseBaseHref(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/') return '/';
  // A relative `<base href="./">` says "wherever this document is", which is not something a
  // static read can resolve to a path — treat it as the root rather than inventing one.
  if (trimmed === './' || trimmed === '.') return '/';
  return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

/**
 * Files that configure a router, most conventional first.
 *
 * A targeted glob rather than a sweep of every `.ts`: router setup lives in a handful of files by
 * convention, and matching `useHash: true` against every component in the app would eventually find
 * the string in a comment or a fixture and report hash routing for an app that has none. A false
 * positive here is worse than a miss — a miss defaults and says so, where a false positive presents
 * a wrong answer with `confidence: "detected"`.
 */
const ROUTER_SETUP_GLOBS = [
  'main.ts',
  'app.config.ts',
  'app.module.ts',
  'app/app.config.ts',
  'app/app.module.ts',
  'app/*.routes.ts',
];

function routerSetupTexts(targetDir: string, cwd: string): string[] {
  const src = dirname(targetDir);
  const roots = [src, cwd];
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const pattern of ROUTER_SETUP_GLOBS) {
      let matches: string[];
      try {
        matches = globSync(pattern, { cwd: root }).map(m => resolve(root, m));
      } catch {
        continue;
      }
      for (const file of matches) {
        if (seen.has(file)) continue;
        seen.add(file);
        try {
          texts.push(readFileSync(file, 'utf8'));
        } catch {
          // Unreadable is the same as absent for this purpose.
        }
      }
    }
  }
  return texts;
}

export interface DetectAppIdentityOptions {
  targetDir: string;
  cwd: string;
  overrides?: AppIdentityOverrides;
}

export interface AppIdentityResult {
  app: AppIdentity;
  /** Reserved: real extraction gaps (an unreadable index.html that clearly WAS the app's) belong
   *  here. A defaulted base href does not — see the note in {@link detectAppIdentity}. */
  diagnostics: string[];
}

export function detectAppIdentity(options: DetectAppIdentityOptions): AppIdentityResult {
  const { targetDir, cwd, overrides = {} } = options;
  const diagnostics: string[] = [];

  let baseHref: string | undefined;
  let routerMode: RouterMode | undefined;
  let detectedAnything = false;

  for (const path of indexHtmlCandidates(targetDir, cwd)) {
    if (!existsSync(path)) continue;
    try {
      const match = BASE_HREF_TAG.exec(readFileSync(path, 'utf8'));
      if (match) {
        baseHref = normaliseBaseHref(match[1]);
        detectedAnything = true;
      }
    } catch {
      // Unreadable index.html: fall through to the provider form. Not worth a diagnostic — the
      // file being absent and being unreadable mean the same thing to this function.
    }
    break;
  }

  for (const text of routerSetupTexts(targetDir, cwd)) {
    if (baseHref === undefined) {
      const provider = APP_BASE_HREF_PROVIDER.exec(text);
      if (provider) {
        baseHref = normaliseBaseHref(provider[1]);
        detectedAnything = true;
      }
    }
    if (routerMode === undefined && (HASH_LOCATION.test(text) || USE_HASH.test(text))) {
      routerMode = 'hash';
      detectedAnything = true;
    }
    if (baseHref !== undefined && routerMode !== undefined) break;
  }

  const resolvedBase = overrides.baseHref !== undefined
    ? normaliseBaseHref(overrides.baseHref)
    : baseHref ?? '/';
  const resolvedMode: RouterMode = overrides.routerMode ?? routerMode ?? 'path';

  const configured = overrides.baseHref !== undefined || overrides.routerMode !== undefined;
  const confidence: AppIdentity['confidence'] =
    configured ? 'configured' : detectedAnything ? 'detected' : 'default';

  // Deliberately NOT a `diagnostics` entry. `docs/schema.md` defines a diagnostic as "treat this
  // part of the manifest as incomplete", and a defaulted base href is not incomplete — it is a
  // complete answer held with less confidence, which is exactly what `confidence` reports and
  // reports in a structured field rather than a string. Most apps are served from the root and set
  // no <base href>, so emitting a diagnostic here would make `diagnostics` non-empty for nearly
  // every run and train readers to ignore a field whose whole value is that it is usually empty.
  // The CLI prints a hint to stderr instead: that reaches the person running it without putting
  // advice inside the artifact.

  return {
    app: { baseHref: resolvedBase, routerMode: resolvedMode, confidence },
    diagnostics,
  };
}
