// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UI_FEATURE } from "./index.js";

afterEach(cleanup);

describe("@spec-lantern/ui scaffolding", () => {
  it("renders a React component in jsdom via @testing-library/react", () => {
    render(<span>{UI_FEATURE}</span>);
    expect(screen.getByText("spec-lantern")).toBeTruthy();
  });
});
