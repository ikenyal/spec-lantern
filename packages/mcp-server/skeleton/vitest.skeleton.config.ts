import { defineConfig } from "vitest/config";

/**
 * Vitest config for the walking-skeleton Correctness_Property test file(s).
 *
 * The skeleton property tests deliberately live OUTSIDE the host CI suite
 * (the src-only include glob in the root vitest.config.ts) because
 * they are meant to execute inside the Isolated_Runner against the
 * writing-tracker Target_Repo (tasks 4.2/4.3), never as part of the host test
 * run. This config lets the runner — and a developer verifying the file — run
 * the skeleton property deterministically and have it terminate with exactly
 * one of PASS or FAIL.
 *
 * The global 100-iteration floor is enforced inline in each test via
 * `{ numRuns: 100 }`, so no shared setup file is required here.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["writing-tracker-monthly-order/properties/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
