// Feature: spec-lantern — Revive loop copy-and-apply tests (task 15.1).
//
// Focused integration tests for the copy-and-apply mechanism in
// ./apply-fixes.ts. They prove the three guarantees task 15.1 is responsible
// for (R8.1 / R8.2):
//   (a) Fix_Tasks are applied to the Target_Repo_Copy (edits land in the copy).
//   (b) The ORIGINAL Target_Repo is byte-for-byte unchanged after applying —
//       verified by hashing every original file before AND after the apply.
//   (c) A Fix_Task whose appliesTo is NOT "Target_Repo_Copy" is rejected before
//       any filesystem work.
//
// These use a real throwaway on-disk Target_Repo built under mkdtemp (mirroring
// the other mcp-server filesystem tests) and a separate copy-parent dir, so no
// process is spawned and nothing the production code owns is touched. This
// module never runs install/build/test — that is task 15.2 — so these tests
// perform no execution either.

import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FixTask } from "@spec-lantern/types";
import {
  applyFixesToCopy,
  assertAppliesToCopy,
  cleanupTargetRepoCopy,
  copyTargetRepo,
  type FixApplication,
} from "./apply-fixes.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Recursively list every FILE under `root` as repo-relative POSIX paths, paired
 * with the sha256 of its bytes. This is the byte-for-byte fingerprint used to
 * assert the original is untouched (every path + every hash equal before/after).
 */
async function hashTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const bytes = await readFile(abs);
        const rel = relative(root, abs).split(sep).join("/");
        out.set(rel, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  }
  await walk(root);
  return out;
}

/** Build a well-formed Fix_Task (appliesTo pinned to the copy). */
function fixTask(id: string, confirmedBugPropertyId = "property-1"): FixTask {
  return {
    id,
    confirmedBugPropertyId,
    description: `fix for ${confirmedBugPropertyId}`,
    appliesTo: "Target_Repo_Copy",
  };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let originalRepo: string;
let copyParent: string;
const createdCopies: string[] = [];

beforeEach(async () => {
  originalRepo = await mkdtemp(join(tmpdir(), "spec-lantern-orig-"));
  copyParent = await mkdtemp(join(tmpdir(), "spec-lantern-copyparent-"));

  // A small but realistic Target_Repo: a source file with the buggy logic, a
  // nested source file, and a node_modules dir that should NOT be copied.
  await writeFile(
    join(originalRepo, "package.json"),
    JSON.stringify({ name: "target", version: "1.0.0" }, null, 2),
  );
  await mkdir(join(originalRepo, "src"), { recursive: true });
  await writeFile(
    join(originalRepo, "src", "order.ts"),
    "export const reverse = true; // Reverse to have most recent month first\n",
  );
  await writeFile(
    join(originalRepo, "src", "keep.ts"),
    "export const keep = 1;\n",
  );
  // A heavy dir that must be excluded from the copy.
  await mkdir(join(originalRepo, "node_modules", "dep"), { recursive: true });
  await writeFile(
    join(originalRepo, "node_modules", "dep", "index.js"),
    "module.exports = {};\n",
  );
});

afterEach(async () => {
  for (const copy of createdCopies.splice(0)) {
    await cleanupTargetRepoCopy(copy);
  }
  await rm(originalRepo, { recursive: true, force: true });
  await rm(copyParent, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* (a) fixes are applied to the copy                                          */
/* -------------------------------------------------------------------------- */

describe("applyFixesToCopy — applies fixes to the copy (R8.1/R8.2)", () => {
  it("writes each Fix_Task's edits into the Target_Repo_Copy", async () => {
    const applications: FixApplication[] = [
      {
        fixTask: fixTask("fix-1"),
        edits: [
          {
            kind: "write",
            path: "src/order.ts",
            // The fix: stop reversing (the real monthly-order bug).
            contents: "export const reverse = false; // fixed: current month first\n",
          },
          {
            kind: "write",
            path: "src/new-helper.ts",
            contents: "export const helper = () => 42;\n",
          },
        ],
      },
      {
        fixTask: fixTask("fix-2", "property-2"),
        edits: [{ kind: "delete", path: "src/keep.ts" }],
      },
    ];

    const result = await applyFixesToCopy(originalRepo, applications, {
      copyParentDir: copyParent,
    });
    createdCopies.push(result.targetRepoCopyPath);

    expect(result.appliedFixTaskIds).toEqual(["fix-1", "fix-2"]);
    expect(result.editsApplied).toBe(3);

    // The copy reflects every edit.
    const orderCopy = await readFile(
      join(result.targetRepoCopyPath, "src", "order.ts"),
      "utf8",
    );
    expect(orderCopy).toContain("reverse = false");

    const helperCopy = await readFile(
      join(result.targetRepoCopyPath, "src", "new-helper.ts"),
      "utf8",
    );
    expect(helperCopy).toContain("helper");

    // The deleted file is gone from the copy.
    await expect(
      stat(join(result.targetRepoCopyPath, "src", "keep.ts")),
    ).rejects.toThrow();

    // node_modules was excluded from the copy (lean copy).
    await expect(
      stat(join(result.targetRepoCopyPath, "node_modules")),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* (b) the original is byte-for-byte unchanged                                */
/* -------------------------------------------------------------------------- */

describe("applyFixesToCopy — leaves the original untouched (R8.2)", () => {
  it("the original Target_Repo is byte-for-byte unchanged after applying", async () => {
    const before = await hashTree(originalRepo);

    const applications: FixApplication[] = [
      {
        fixTask: fixTask("fix-1"),
        edits: [
          {
            kind: "write",
            path: "src/order.ts",
            contents: "export const reverse = false;\n",
          },
          { kind: "delete", path: "src/keep.ts" },
          { kind: "write", path: "src/added.ts", contents: "export const x = 1;\n" },
        ],
      },
    ];

    const result = await applyFixesToCopy(originalRepo, applications, {
      copyParentDir: copyParent,
    });
    createdCopies.push(result.targetRepoCopyPath);

    const after = await hashTree(originalRepo);

    // Same set of files AND same bytes for each — the original is sacred.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash);
    }

    // And the copy genuinely diverged (so we know the edits went SOMEWHERE).
    const copyHashes = await hashTree(result.targetRepoCopyPath);
    expect(copyHashes.get("src/order.ts")).not.toBe(before.get("src/order.ts"));
    expect(copyHashes.has("src/keep.ts")).toBe(false);
    expect(copyHashes.has("src/added.ts")).toBe(true);
  });

  it("copyTargetRepo alone never mutates the original", async () => {
    const before = await hashTree(originalRepo);
    const copyRoot = await copyTargetRepo(originalRepo, {
      copyParentDir: copyParent,
    });
    createdCopies.push(copyRoot);
    const after = await hashTree(originalRepo);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash);
    }
    // Copy excludes node_modules.
    expect([...copyHashKeys(await hashTree(copyRoot))]).not.toContain(
      "node_modules/dep/index.js",
    );
  });
});

function copyHashKeys(map: Map<string, string>): string[] {
  return [...map.keys()];
}

/* -------------------------------------------------------------------------- */
/* (c) appliesTo other than "Target_Repo_Copy" is rejected                    */
/* -------------------------------------------------------------------------- */

describe("applyFixesToCopy — rejects non-copy targets (R8.2)", () => {
  it("throws when a Fix_Task appliesTo is not Target_Repo_Copy, before any copy", async () => {
    const before = await hashTree(originalRepo);

    const bad = {
      id: "bad-fix",
      confirmedBugPropertyId: "property-1",
      description: "sneaky fix that targets the original",
      // Deliberately illegal value (as if deserialized off the MCP wire).
      appliesTo: "Target_Repo" as unknown as "Target_Repo_Copy",
    } satisfies FixTask;

    const applications: FixApplication[] = [
      {
        fixTask: bad,
        edits: [{ kind: "write", path: "src/order.ts", contents: "pwned\n" }],
      },
    ];

    await expect(
      applyFixesToCopy(originalRepo, applications, { copyParentDir: copyParent }),
    ).rejects.toThrow(/Target_Repo_Copy/);

    // The original was not touched (the guard runs before any copy/write).
    const after = await hashTree(originalRepo);
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash);
    }

    // No copy directory should have been created either.
    const parentEntries = await readdir(copyParent);
    expect(parentEntries).toHaveLength(0);
  });

  it("assertAppliesToCopy accepts the copy target and rejects others", () => {
    expect(() => assertAppliesToCopy(fixTask("ok"))).not.toThrow();
    expect(() =>
      assertAppliesToCopy({
        id: "nope",
        confirmedBugPropertyId: "property-1",
        description: "x",
        appliesTo: "elsewhere" as unknown as "Target_Repo_Copy",
      }),
    ).toThrow(/Target_Repo_Copy/);
  });
});

/* -------------------------------------------------------------------------- */
/* Boundary confinement: an escaping edit cannot reach the original           */
/* -------------------------------------------------------------------------- */

describe("applyFixesToCopy — confines edits to the copy boundary (R12.6)", () => {
  it("rejects an edit path that escapes the copy with ..", async () => {
    const before = await hashTree(originalRepo);
    const applications: FixApplication[] = [
      {
        fixTask: fixTask("escape-fix"),
        edits: [
          { kind: "write", path: "../escape.ts", contents: "escaped\n" },
        ],
      },
    ];

    await expect(
      applyFixesToCopy(originalRepo, applications, { copyParentDir: copyParent }),
    ).rejects.toThrow(/escapes the Target_Repo_Copy boundary/);

    // Original untouched by the rejected escaping edit.
    const after = await hashTree(originalRepo);
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash);
    }
  });

  it("rejects an absolute edit path", async () => {
    const applications: FixApplication[] = [
      {
        fixTask: fixTask("abs-fix"),
        edits: [
          { kind: "write", path: join(originalRepo, "src", "order.ts"), contents: "x\n" },
        ],
      },
    ];
    await expect(
      applyFixesToCopy(originalRepo, applications, { copyParentDir: copyParent }),
    ).rejects.toThrow(/repo-relative/);
  });
});
