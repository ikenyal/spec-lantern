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
- the claim's comment quoted verbatim (comment text only, no code) with its exact
  `file:line`,
- an in-file tag comment `Feature: spec-lantern, Property {n}: {property_text}`,
- the test terminates with exactly one of PASS or FAIL.

Use **fast-check + Vitest**, a minimum of 100 iterations per property. Write a
smart generator that covers the WHOLE documented input space (e.g. every minute
0-59, not a hand-picked subset). Never narrow a generator to avoid a value you
suspect. Author the property to assert the *intended* behavior the comment
states (e.g. "the first row is the current month").

### How to import the target under test

The property runs inside a COPY of the Target_Repo, from the SAME location
(relative to the target) it has in your spec. Import the target so that location
is honored:

- **Prefer the target's `@/...` alias when it defines one** (most Vite/CRA apps
  do — check `vite.config.*` / `tsconfig.json` `paths`). The runner preserves the
  target's alias config, so `import { getClosingSoonInfo } from "@/utils/openingHoursParser"`
  resolves no matter where the spec sits. This is the ONLY form that works when
  your spec root is OUTSIDE the target (the server copies the whole spec to a
  fixed path, changing its depth).
- **Otherwise import relative to the property file's REAL location inside the
  target.** When your spec root is INSIDE the target (e.g.
  `<target>/.spec-lantern/src-utils/`), the property file keeps that path in the
  copy, so a relative import must climb from `.../properties/` to the source —
  e.g. from `<target>/.spec-lantern/src-utils/properties/property-1.*.test.ts`,
  the module at `<target>/src/utils/openingHoursParser.ts` is
  `../../../src/utils/openingHoursParser`.

Do NOT assume the property file lives at the target root. The server never
flattens property files to `<copy>/properties/`; it runs each one from its own
spec location so these imports resolve.

### Oracles must be independent of the code under test

An oracle that restates the implementation (same formula, same branches, the
function's own output, or a sibling function's output) passes even when the code
is wrong. That is "read and believe" in test form, and it defeats the product.
Build every expected value from a source the code cannot influence:

- the comment's own examples ("500 m", "1.2 km", "10:00 PM"),
- known real-world values (e.g. a known city-to-city distance with a tolerance),
- mathematical laws (identity, symmetry, monotonicity, round-trips),
- the answer side first: generate the intended result (e.g. hour24, minute),
  format it into the input string, and expect the result you started from,
- an explicit hand-written table of input -> expected output.

Self-check before locking: "Could this expected value be produced by copying
the function body?" If yes, rewrite the oracle. Never assert a value against the
code's own output. Copying also includes:

- transcribing the source's data or constants into an "expected" table (for
  example copying a config array, including entries no comment mentions); build
  the table only from what the comments say,
- re-expressing the same branching for random inputs (`x < 1 ? ... : ...`) even
  if fixed comment examples are also checked,
- escape hatches such as "if the result is null, accept it" that let the very
  defect under test pass.

### Do not simulate the target before locking

Never copy, transcribe, or re-implement the target's functions (for example in
`node -e`) to check whether a property will pass. That is executing the target
outside the isolated runner, and it tunes tests to the code. If you are unsure
whether an oracle is right, say so instead.

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

1. Read the code and predict what you **actually believe**: exactly one of PASS
   or FAIL. If you suspect the code does not do what its comment says, predict
   FAIL and write one line of reasoning. Never predict strategically (for
   example "PASS so that a mismatch is meaningful"); a prediction you do not
   believe makes the whole report dishonest. A correct FAIL prediction is a
   valid, useful result: it shows the bug was visible by reading.
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
