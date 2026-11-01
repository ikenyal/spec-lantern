/**
 * Global test setup shared by every Vitest run across all packages.
 *
 * Enforces the project-wide property-based-testing policy from the design:
 * every fast-check property runs a MINIMUM of 100 iterations. We set the
 * global `numRuns` to 100 so individual tests do not need to repeat it, and
 * any test that raises it stays above the floor.
 */
import fc from "fast-check";

export const MIN_FAST_CHECK_RUNS = 100;

fc.configureGlobal({
  numRuns: MIN_FAST_CHECK_RUNS,
});
