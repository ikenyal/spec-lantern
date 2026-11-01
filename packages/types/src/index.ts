/**
 * @spec-lantern/types
 *
 * Shared, serializable domain types for the spec-lantern pipeline. The
 * concrete domain model (Claim, CorrectnessProperty, ActualResult, etc.) is
 * fleshed out in task 2.1. This module only establishes the package boundary
 * so `kiro-power`, `mcp-server`, and `ui` can import from a single shared
 * source during scaffolding.
 */

/** Closed verdict enum. Timeouts and execution errors are never a Verdict. */
export type Verdict = "PASS" | "FAIL";

/** Library/package metadata, used as a trivial shared value during setup. */
export const SPEC_LANTERN = "spec-lantern" as const;
