// @vitest-environment jsdom
/**
 * Feature: spec-lantern — the Radix activation helper the render shim ships
 * (FEAT-003, GAP 3).
 *
 * This is the EXECUTED proof behind the FEAT: it renders a MINIMAL real Radix
 * Tabs (`Tabs.Root`/`Tabs.List`/`Tabs.Trigger`/`Tabs.Content`) whose second
 * `TabsContent` is unmounted initially (Radix unmounts inactive content by
 * default), confirms the second panel is NOT queryable, then runs the EXACT
 * activation sequence the runner shim embeds — the exported
 * `installJsdomPointerCaptureShims` + `activateTabByName` from
 * `component-render.ts`, serialized verbatim into
 * `buildDomInteractionShimModule()` — and confirms the previously-unmounted
 * `TabsContent` becomes queryable.
 *
 * It must be its OWN file with the `// @vitest-environment jsdom` pragma: the
 * sibling `component-render.test.ts` deliberately stays node-env for the pure
 * string builders, and this one needs a DOM + the real `@testing-library/react`
 * `fireEvent`. `@radix-ui/react-tabs` is a pinned devDependency used ONLY here
 * (it is never bundled into the packaged power).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import {
  activateTabByName,
  installJsdomPointerCaptureShims,
} from "./component-render.js";

afterEach(cleanup);

/**
 * A minimal REAL Radix Tabs with two tabs. "First" is the default value, so
 * Radix mounts only the first panel; the second panel's content is unmounted
 * until its tab is activated. Built with `createElement` (this is a `.tsx` file
 * but the pattern mirrors the generated `.ts` property files).
 */
function renderMinimalTabs(): void {
  render(
    createElement(
      Tabs.Root,
      { defaultValue: "first" },
      createElement(
        Tabs.List,
        null,
        createElement(Tabs.Trigger, { value: "first" }, "First"),
        createElement(Tabs.Trigger, { value: "second" }, "Second"),
      ),
      createElement(Tabs.Content, { value: "first" }, "first panel body"),
      createElement(
        Tabs.Content,
        { value: "second" },
        createElement("span", { "data-testid": "second-body" }, "second panel body"),
      ),
    ),
  );
}

describe("activateTab mounts a Radix TabsContent that is unmounted initially", () => {
  it("the second TabsContent is NOT queryable before activation", () => {
    renderMinimalTabs();
    // Radix unmounts inactive content by default — the second body is absent.
    expect(screen.queryByTestId("second-body")).toBeNull();
    expect(screen.queryByText("second panel body")).toBeNull();
  });

  it("becomes queryable after activateTab('Second') via the shipped sequence", () => {
    // The shim installs these onto the real Element.prototype before any
    // pointer interaction; do the same here so we exercise the shipped path.
    installJsdomPointerCaptureShims(Element);

    renderMinimalTabs();
    expect(screen.queryByTestId("second-body")).toBeNull();

    // The EXACT helper the runner shim embeds verbatim.
    activateTabByName("Second", { fireEvent }, document);

    // The previously-unmounted TabsContent is now mounted and queryable.
    const body = screen.queryByTestId("second-body");
    expect(body, "expected the second tab panel to mount after activateTab").not.toBeNull();
    expect(screen.queryByText("second panel body")).not.toBeNull();
  });

  it("throws a readable error naming the tab when no trigger matches", () => {
    installJsdomPointerCaptureShims(Element);
    renderMinimalTabs();
    expect(() =>
      activateTabByName("Nonexistent", { fireEvent }, document),
    ).toThrow(/Nonexistent/);
  });
});
