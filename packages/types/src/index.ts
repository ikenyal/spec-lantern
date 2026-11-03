/**
 * @spec-lantern/types
 *
 * Shared, serializable domain types for the spec-lantern pipeline.
 *
 * All models are plain serializable JSON (no classes, no methods) so they can
 * cross the MCP boundary and be rendered by the UI. PASS/FAIL is a closed enum;
 * timeouts and execution errors are *distinct* outcomes, never encoded as PASS
 * or FAIL (this distinction is central to R5.7, R5.9, R7.4).
 */

/** Closed verdict enum. Timeouts and execution errors are never a Verdict. */
export type Verdict = "PASS" | "FAIL";

/** A statement of intended behavior found in the Target_Repo. */
export interface Claim {
  id: string;
  /** The claimed behavior. */
  description: string;
  /** R1.3: originating file. */
  sourceFile: string;
  /** R1.3: the comment/line it was derived from. */
  commentRef: string;
  /** R3.6: present when the Claim cannot be expressed as a property. */
  unverifiable?: {
    reason: string;
  };
}

/** Difference between claimed and current behavior. (R2) */
export interface ObservedDeviation {
  id: string;
  /** R2.1/R2.2: reference to originating Claim. */
  claimId: string;
  claimedBehavior: string;
  /** null => could not be determined (R2.4). */
  currentBehavior: string | null;
  /** R2.4. */
  undeterminable?: boolean;
}

/** Executable assertion derived 1:1 from a Claim. (R3.1) */
export interface CorrectnessProperty {
  id: string;
  /** Exactly one Claim -> one property. */
  claimId: string;
  title: string;
  /** "for all ..." universal statement. */
  statement: string;
  /** R4. */
  kind: "function" | "component_rendered";
  /**
   * R4.1: component_rendered is only used for PROPS-DRIVEN components
   * (data supplied via props). Components that fetch data internally
   * (e.g. a Supabase client) are NOT rendered; the Claim is instead
   * recorded as unverifiable (see Claim.unverifiable, R3.6).
   */
  embeddedComponentLogic?: {
    componentPath: string;
    /** Injected via props. */
    mockedData: unknown;
  };
  /** e.g. ["7.1","7.2"]. */
  validatesRequirements: string[];
}

/** Agent's read-only prediction, recorded before execution, immutable after. (R3.4, R3.5) */
export interface PredictedResult {
  propertyId: string;
  verdict: Verdict;
  /** Timestamp proving it predates execution. */
  recordedAt: string;
  /** Once execution begins it is never rewritten. */
  immutable: true;
}

/**
 * A tamper-evident lock over a Predicted_Result, written before execution
 * begins so the prediction cannot silently change afterward. (R3.4, R3.5)
 *
 * `contentHash` is computed over the serialized Predicted_Result AND the bytes
 * of the Correctness_Property test file it refers to; a later edit to either
 * makes a recomputed hash disagree with `contentHash`, so drift is detectable.
 * `verdict` is the originally recorded value, surfaced directly so comparison
 * (R7) reads it without re-trusting the (possibly edited) prediction file.
 */
export interface PredictionLock {
  propertyId: string;
  /** The originally recorded verdict (R3.5). */
  verdict: Verdict;
  /** Pinned so a reader hashes with the same algorithm the writer used. */
  hashAlgorithm: "sha256";
  /** Hex digest over (Predicted_Result + Correctness_Property bytes). */
  contentHash: string;
  /** Execution-start boundary: when the prediction was locked. */
  lockedAt: string;
}

/** Reproduction values for a single execution. (R6.1) */
export interface ExecutionContext {
  /** fast-check seed (R6). */
  randomSeed: number;
  /** e.g. "UTC". */
  timezone: string;
  /** ISO instant pinned by Controllable_Clock. */
  fixedCurrentTime: string;
}

/** Concrete failing input/output. (R5.6) */
export interface Counterexample {
  propertyId: string;
  /** Values that triggered the failure. */
  input: unknown;
  /** What the code actually produced. */
  observedOutput: unknown;
  /** R6.2: bundled for exact replay. */
  executionContext: ExecutionContext;
}

/**
 * Outcome of executing one property. Exactly one of these shapes.
 *
 * Timeouts and execution errors are distinct outcomes and are NEVER encoded as
 * PASS/FAIL (R5.7, R5.9). The TIMEOUT outcome carries `limitSeconds` = the
 * limit actually in effect for the run, not a literal constant.
 */
export type ActualResult =
  | {
      propertyId: string;
      outcome: "VERDICT";
      verdict: Verdict;
      counterexample?: Counterexample;
    }
  // R5.7 (configured execution timeout; default 30).
  | { propertyId: string; outcome: "TIMEOUT"; limitSeconds: number }
  // R5.9.
  | { propertyId: string; outcome: "EXECUTION_ERROR"; reason: string }
  // R5.8, R12.5.
  | { propertyId: string; outcome: "RUNNER_UNAVAILABLE"; reason: string }
  // R12.4.
  | { propertyId: string; outcome: "SAFETY_VIOLATION"; reason: string };

/** Request across the MCP boundary. */
export interface PropertyExecutionRequest {
  /** Path or copy reference (never executed on host). */
  targetRepoRef: string;
  properties: CorrectnessProperty[];
  phase: "initial" | "post_fix";
}

/** Response across the MCP boundary. */
export interface PropertyExecutionResult {
  results: ActualResult[];
  /** Per propertyId. */
  executionContexts: Record<string, ExecutionContext>;
}

/** Revive loop. (R8) */
export interface FixTask {
  id: string;
  /** R8.1: >=1 per Confirmed_Bug. */
  confirmedBugPropertyId: string;
  description: string;
  /** R8.2: never the original. */
  appliesTo: "Target_Repo_Copy";
}

/** Pre/post-fix transition for a single property. (R8) */
export interface PropertyTransition {
  propertyId: string;
  /** R8.4. */
  preFixResult: Verdict;
  /** R8.4. */
  postFixResult: Verdict;
  classification:
    // FAIL -> PASS.
    | "FIXED"
    // FAIL -> FAIL (R8.6).
    | "NOT_RESOLVED"
    // PASS -> FAIL (R8.7).
    | "REGRESSION"
    // PASS -> PASS.
    | "STILL_PASSING";
}

/**
 * Presentation metadata for a Correctness_Property, carried alongside its
 * comparison so the UI can make the lying Claim the hero of a row without
 * re-deriving it: the human-readable `title`, the original `claimText` (the
 * verbatim code comment the Claim was reverse-engineered from), and the
 * `sourceLocation` that comment lives at (e.g. "PeriodProgressSummary.tsx:54").
 * Optional end-to-end: a comparison with no display metadata still renders
 * (the UI falls back to the propertyId), so existing producers are unaffected.
 */
export interface PropertyDisplay {
  /** Human-readable property title, shown as the row heading. */
  title?: string;
  /** The original (often wrong) code comment, shown as a quoted headline. */
  claimText?: string;
  /** Where the comment lives, e.g. "PeriodProgressSummary.tsx:54". */
  sourceLocation?: string;
}

/** Per-property comparison record built by the Comparison Engine. (R7) */
export interface PropertyComparison {
  propertyId: string;
  /** Optional presentation metadata (title, original claim, source). */
  display?: PropertyDisplay;
  predicted: Verdict | null;
  actual: ActualResult;
  status:
    | "MATCH"
    // R7.2.
    | "PREDICTION_MISMATCH"
    // R7.4.
    | "NOT_COMPARED_TIMEOUT"
    // R7.5.
    | "NOT_EXECUTED";
  /** R7.3 (true only when actual verdict is FAIL). */
  confirmedBug: boolean;
  transition?: PropertyTransition;
}

/** The structured report. (R9) */
export interface LanternReport {
  /** One per evaluated property (R9.2). */
  comparisons: PropertyComparison[];
  /** R9.4. */
  observedDeviations: ObservedDeviation[];
  /** R9.6. */
  noConfirmedBug: boolean;
  /** R9.7. */
  noObservedDeviation: boolean;
  /** Within 10s of comparison (R9.1). */
  generatedAt: string;
}

/**
 * Tunable limits. Defaults satisfy R5.7 (<=30s), R9.1 (<=10s), R10.2 (<=3s).
 *
 * These are read from configuration, not hard-coded at use sites. The
 * `ActualResult` TIMEOUT outcome carries the limit value actually in effect
 * (`limitSeconds`) rather than a literal constant, so a replayed or
 * reconfigured run records the timeout it was actually subject to.
 */
export interface LimitsConfig {
  /** default 30 (R5.7). */
  executionTimeoutSeconds: number;
  /** default 10 (R9.1). */
  reportGenerationLimitSeconds: number;
  /** default 3 (R10.2). */
  uiRenderLimitSeconds: number;
}

/** Default limits that satisfy the requirement thresholds out of the box. */
export const DEFAULT_LIMITS: LimitsConfig = {
  executionTimeoutSeconds: 30,
  reportGenerationLimitSeconds: 10,
  uiRenderLimitSeconds: 3,
};

/** Library/package metadata, used as a trivial shared value during setup. */
export const SPEC_LANTERN = "spec-lantern" as const;

/**
 * On-disk artifact schemas and conventions (the persisted formats Kiro writes
 * and the Validator consumes). Distinct from the in-memory types above; see
 * ./artifacts.ts for the full contract.
 */
export * from "./artifacts.js";
