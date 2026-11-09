// Feature: spec-lantern — auto-jsdom detection unit tests (packaged-Power stumble #2)
//
// EXAMPLE-BASED unit tests for the dom-detect module's pure
// propertyFileNeedsDom scan. They assert that a property file which touches the
// DOM (imports react-dom / testing-library / a .tsx module) without an explicit
// per-file environment pragma is detected so the test phase can default it to
// jsdom, while an explicit pragma always wins and a plain function property is
// left under node.
//
// NOTE: the per-file environment pragma token is assembled from fragments in
// each test (see `PRAGMA`) rather than written literally, so Vitest's own
// top-of-file pragma scanner does not mistake these fixtures for a directive on
// THIS test file.

import { describe, expect, it } from "vitest";
import { propertyFileNeedsDom } from "./dom-detect.js";

// Assembled so it is not a literal directive Vitest's scanner would pick up.
const PRAGMA = (env: string) => `// @vitest-${"environment"} ${env}`;

describe("propertyFileNeedsDom — detect a DOM-touching property with no pragma", () => {
  it("detects an @testing-library/react import", () => {
    const source = [
      'import { test } from "vitest";',
      'import { render, screen } from "@testing-library/react";',
      'import { BookList } from "@/components/BookList";',
      "",
      'test("renders", () => {',
      "  render(<BookList books={[]} />);",
      "});",
    ].join("\n");
    expect(propertyFileNeedsDom(source)).toBe(true);
  });

  it("detects a react-dom import (and its subpaths)", () => {
    expect(
      propertyFileNeedsDom('import { createRoot } from "react-dom/client";'),
    ).toBe(true);
    expect(propertyFileNeedsDom('import ReactDOM from "react-dom";')).toBe(true);
  });

  it("detects an import of a .tsx module", () => {
    const source = 'import { Card } from "../../../src/components/PlaceCard.tsx";';
    expect(propertyFileNeedsDom(source)).toBe(true);
  });

  it("detects a dynamic import and a require of a DOM module", () => {
    expect(
      propertyFileNeedsDom('const tl = await import("@testing-library/react");'),
    ).toBe(true);
    expect(propertyFileNeedsDom('const rd = require("react-dom");')).toBe(true);
  });

  it("stands down when an explicit environment pragma is present (author wins)", () => {
    // Even though it imports testing-library, the explicit pragma means the
    // author made a choice; auto-jsdom must not second-guess it.
    const jsdomPragma = [
      PRAGMA("jsdom"),
      'import { render } from "@testing-library/react";',
    ].join("\n");
    expect(propertyFileNeedsDom(jsdomPragma)).toBe(false);

    // A node pragma on a DOM-importing file is still the author's explicit
    // choice — we never override it behind the author's back.
    const nodePragma = [
      PRAGMA("node"),
      'import { render } from "@testing-library/react";',
    ].join("\n");
    expect(propertyFileNeedsDom(nodePragma)).toBe(false);
  });

  it("returns false for a plain function property (no DOM imports)", () => {
    const source = [
      'import { test } from "vitest";',
      'import fc from "fast-check";',
      'import { parseOpeningHours } from "../../../src/utils/openingHoursParser";',
      "",
      'test("parses", () => {',
      '  fc.assert(fc.property(fc.string(), (s) => typeof parseOpeningHours(s) === "object"));',
      "});",
    ].join("\n");
    expect(propertyFileNeedsDom(source)).toBe(false);
  });

  it("does not match a package name that merely appears in prose or an identifier", () => {
    // "react-dom" in a comment or as part of an unrelated identifier must not
    // trigger jsdom — only an actual import/require specifier counts.
    const source = [
      "// this property does not use the dom renderer at all",
      "const reactDomLike = 1;",
      'import { test } from "vitest";',
    ].join("\n");
    expect(propertyFileNeedsDom(source)).toBe(false);
  });
});
