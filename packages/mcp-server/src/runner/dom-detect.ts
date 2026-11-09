/**
 * Auto-jsdom detection for a property test file (packaged-Power stumble #2).
 *
 * A `component_rendered` property that renders a React component needs a
 * browser-like DOM. Under the GENERIC execute path the per-run Vitest config
 * leaves `test.environment` to the target (usually `node`), so a property that
 * forgets the `// @vitest-environment jsdom` pragma crashes on the first touch
 * of `document`/`window` with "ReferenceError: document is not defined". The
 * runner already surfaces that as an ACTIONABLE hint
 * ({@link ./vitest-classify.ts} `domEnvironmentHint`), but a real packaged-Power
 * run showed authors still omit the pragma and hit the crash.
 *
 * This module closes the common case BEFORE the run: it scans the property
 * file's SOURCE for the imports that imply a DOM — `react-dom` (and
 * `react-dom/*`), `@testing-library/*`, or an import of a `.tsx` module — and
 * reports whether a DOM environment is needed. The test phase then defaults the
 * generated config's environment to `jsdom` when so (see
 * {@link ./execution-context.ts} `buildSeedClockVitestConfig`'s `autoJsdom`).
 *
 * EXPLICIT PRAGMA STILL WINS. When the file already declares a
 * `// @vitest-environment <env>` pragma (jsdom OR anything else), the author has
 * made an explicit choice; this returns `false` so the pragma — which Vitest
 * honours over the config environment anyway — is never second-guessed. The
 * auto-default is only for files that set NO environment at all.
 *
 * PURE + CONSERVATIVE. It is a pure string scan (no I/O, no parse) so it is
 * directly unit-testable, and it is deliberately conservative: it only matches
 * import/require statements (not arbitrary prose mentioning "react-dom"), and a
 * miss is harmless — the existing `domEnvironmentHint` still catches a DOM crash
 * the scan did not foresee and tells the author to add the pragma.
 */

/**
 * The regex that recognizes an explicit per-file Vitest environment pragma
 * (`// @vitest-environment jsdom`, `/* @vitest-environment node *\/`, etc.).
 * Vitest honours this over the config `environment`, so when it is present the
 * author's choice wins and auto-jsdom must stand down.
 */
const ENVIRONMENT_PRAGMA = /@vitest-environment\s+\S+/;

/**
 * Import/require specifiers (or a `.tsx` module import) that imply the property
 * renders into a DOM and therefore needs the `jsdom` environment. Matched only
 * inside an `import ... from "<spec>"`, a bare `import "<spec>"`, a dynamic
 * `import("<spec>")`, or a `require("<spec>")` — never free prose.
 */
const DOM_IMPORT_SPECIFIER =
  // react-dom and its subpaths (react-dom/client, react-dom/test-utils, …)
  /(?:^|\b)react-dom(?:\/[\w.-]+)*$/;

/** True when a module specifier is a `.tsx` import (relative or bare). */
function isTsxSpecifier(spec: string): boolean {
  const withoutQuery = spec.split("?")[0];
  return withoutQuery.endsWith(".tsx");
}

/** True when a module specifier is an `@testing-library/*` package. */
function isTestingLibrarySpecifier(spec: string): boolean {
  return /^@testing-library\//.test(spec);
}

/** True when a specifier is `react-dom` or one of its subpaths. */
function isReactDomSpecifier(spec: string): boolean {
  return DOM_IMPORT_SPECIFIER.test(spec);
}

/**
 * Extract every module specifier referenced by a static `import`/`export ...
 * from`, a bare `import "x"`, a dynamic `import("x")`, or a `require("x")` in
 * the given source. Conservative: it only reads the quoted specifier of those
 * forms, so prose or identifiers that merely contain a package name are ignored.
 */
function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    // import ... from "spec"  /  export ... from "spec"
    /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g,
    // bare side-effect import:  import "spec"
    /import\s*["']([^"']+)["']/g,
    // dynamic import:  import("spec")
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    // require("spec")
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      specs.push(match[1]);
    }
  }
  return specs;
}

/**
 * Decide whether a property test file needs a DOM (`jsdom`) environment and did
 * NOT declare an explicit environment pragma.
 *
 * Returns `true` only when BOTH hold:
 *  1. the file sets no `@vitest-environment` pragma (if it does, the author's
 *     choice wins and this stands down), and
 *  2. the file imports `react-dom` / `react-dom/*`, an `@testing-library/*`
 *     package, or a `.tsx` module — the signals that it renders into a DOM.
 *
 * Pure string scan; a conservative miss is safe (the runtime DOM hint still
 * catches an unforeseen DOM crash).
 */
export function propertyFileNeedsDom(source: string): boolean {
  // An explicit environment pragma always wins — never override it.
  if (ENVIRONMENT_PRAGMA.test(source)) return false;

  for (const spec of extractImportSpecifiers(source)) {
    if (
      isReactDomSpecifier(spec) ||
      isTestingLibrarySpecifier(spec) ||
      isTsxSpecifier(spec)
    ) {
      return true;
    }
  }
  return false;
}
