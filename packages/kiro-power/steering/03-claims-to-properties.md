---
inclusion: always
---

# 03 — Claims → Correctness_Properties + locked predictions (R3, R4)

Turn every claim into something **executable**. Reading is not enough — each
Claim that can be expressed becomes exactly one executable property test file,
each inexpressible Claim is recorded as unverifiable, and each property gets an
immutable Predicted_Result locked before any execution.

## R3.1 — one expressible Claim → exactly one Correctness_Property test file

For each Claim that **can** be expressed as an executable assertion, author
**exactly one** Correctness_Property, realized as **exactly one** executable
test file. The mapping is strictly 1:1 (Claim ↔ property ↔ file): never zero,
never two. Use the filename, location, tag, and termination convention from
`05-artifact-formats.md`:

- filename `property-{n}.{claimId}.test.ts` under `properties/`,
- an in-file tag comment `Feature: spec-lantern, Property {n}: {property_text}`,
- the test terminates with exactly one of PASS or FAIL.

Use **fast-check + Vitest**, a minimum of 100 iterations per property. Write a
smart generator that constrains inputs to the real input space. Author the
property to assert the *intended* behavior (e.g. "the first row is the current
month"), so execution can expose a gap against a trusting prediction.

Properties run under a pinned clock, timezone, and seed (the runner supplies the
`ExecutionContext`). Write time-dependent assertions against the Fixed_Current_Time,
never the host wall clock.

## R3.6 — inexpressible Claim → unverifiable with a reason

If a Claim cannot be expressed as an executable Correctness_Property, do **not**
emit a property file for it. Instead mark the Claim `unverifiable` with a
non-empty `reason` explaining why it could not be expressed (see the `Claim`
`unverifiable` field in `05-artifact-formats.md`). An unverifiable Claim
produces no property and no prediction.

## R4 — embedded React component logic

Some logic lives inside a React component rather than in an exported function.
Handle it by how the component gets its data:

- **R4.1 / R4.4 — props-driven component** (data arrives via props): mark the
  logic as embedded component logic and derive a Correctness_Property of
  `kind: "component_rendered"` that asserts on the **rendered output** of the
  component (not on source). Record `embeddedComponentLogic` with the
  `componentPath` and the `mockedData` injected via props. The MCP_Server renders
  it in jsdom with a Controllable_Clock and mocked data and evaluates the
  property against the rendered DOM.
- **R3.6 — internally-fetching component** (fetches its own data, e.g. via a
  Supabase client or any internal data fetch): it cannot be rendered
  deterministically for verification. Do **not** derive a component_rendered
  property. Instead record the originating Claim as `unverifiable` with a
  `reason` that **names the internal data dependency** (e.g. "component fetches
  its own data via the Supabase client; no props-injected data path to render
  deterministically").

Distinguish the two by inspecting where the component's data comes from before
choosing. Only props-driven components get a `component_rendered` property.

## R3.4 / R3.5 — record an immutable Predicted_Result, then LOCK

For every Correctness_Property (function or component_rendered), record a
**Predicted_Result before execution**:

1. Read the code and predict honestly: exactly one of PASS or FAIL. If a comment
   says the code does X and the code appears to do X, predict accordingly — the
   point of the product is to surface where that read-only prediction is wrong.
2. Write the Predicted_Result file (`verdict`, pre-execution `recordedAt`
   timestamp, `immutable: true`, `propertyId`) per `05-artifact-formats.md`.
3. **Lock it.** Call the MCP prediction-lock tool over every Predicted_Result
   and the Correctness_Property artifact it refers to. The lock persists a
   content hash + timestamp so the prediction cannot change once execution
   begins.

Only after locking do you proceed to `execute_properties` (see
`04-execute-and-revive.md`). Once execution has begun, treat the Predicted_Result
as immutable: never rewrite it, and let comparison read the locked value. A
wrong prediction is a finding, not a mistake to correct.

## Output of this step

- One `property-{n}.{claimId}.test.ts` file per expressible Claim.
- `claims.json` updated with `unverifiable` + reason for each inexpressible
  Claim (including internally-fetching components).
- One Predicted_Result file per property, all locked via the lock tool.
