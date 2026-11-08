/**
 * Build-time CLI that writes the report sections asset
 * (public/reports/sections.json): the "Behind the lantern" timelines, the "How
 * it stays safe" isolation model, and the "We hold ourselves to the same
 * standard" items.
 *
 * Run with `npm run generate:timeline -w @spec-lantern/ui` (invoked by
 * `build:demo` before the Vite build).
 *
 * This file is a THIN wrapper: all the logic lives in the pure, testable core
 * ({@link ./timeline-core.ts}). Here we only wire in the real `fs` + `git`
 * readers and write the result to disk. It is excluded from the library build
 * and from the test glob; the core is what the tests import.
 *
 * DATA FIDELITY (.kiro/steering/report-data-fidelity.md): every timeline fact
 * is read from `git log`, `locks/*.lock.json` `lockedAt`, or `results/**`
 * `capturedAt`. Nothing is hand-typed from memory.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildSectionsAsset,
  type CommitInfo,
  type TargetSource,
  type TimelineReaders,
} from "./timeline-core.js";

const execFileAsync = promisify(execFile);

/** Run a git command in the repo root and return trimmed stdout (or null on error). */
async function git(
  repoRoot: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", [...args], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Parse one `%h\x1f%s\x1f%cI` git record into a {@link CommitInfo}. */
function parseCommitRecord(line: string): CommitInfo | null {
  if (line.length === 0) return null;
  const [shortHash, subject, date] = line.split("\x1f");
  if (!shortHash || !date) return null;
  return { shortHash, subject: subject ?? "", date };
}

/** Build the real fs+git readers rooted at `repoRoot`. */
function makeRealReaders(repoRoot: string): TimelineReaders {
  const FORMAT = "%h\x1f%s\x1f%cI";
  return {
    readFile: (path) => readFile(path, "utf8"),
    listDir: (path) => readdir(path),
    async firstCommitForPath(repoRelPath) {
      // The FIRST commit that added the path (oldest add-commit).
      const out = await git(repoRoot, [
        "log",
        "--diff-filter=A",
        `--format=${FORMAT}`,
        "--",
        repoRelPath,
      ]);
      if (out === null || out.length === 0) return null;
      const lines = out.split("\n").filter((l) => l.length > 0);
      // `git log` is newest-first; the add is the LAST line.
      return parseCommitRecord(lines[lines.length - 1]);
    },
    async resolveCommit(commitish) {
      const out = await git(repoRoot, [
        "log",
        "-1",
        `--format=${FORMAT}`,
        commitish,
      ]);
      if (out === null) return null;
      return parseCommitRecord(out);
    },
  };
}

async function main(): Promise<void> {
  const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = join(uiRoot, "..", "..");
  const skeletonRel = "packages/mcp-server/skeleton";
  const skeletonAbs = join(repoRoot, skeletonRel);

  const targets: TargetSource[] = [
    {
      id: "writing-tracker",
      label: "writing-tracker",
      rootAbs: join(skeletonAbs, "writing-tracker-full"),
      rootRel: `${skeletonRel}/writing-tracker-full`,
      anchorLockName: "property-1.claim-monthly-order.lock.json",
      executionResultName: "property-1.claim-monthly-order.json",
      replayResultName: "replay-property-1.json",
      fixResultName: "apply-fixes-reexecute-all.json",
      // From writing-tracker-full/locks/superseded/README.md: "The FIRST
      // Stage-C execution ... revealed that property-2 and property-3 contained
      // test-harness defects" — the 2 revisions came AFTER a first run.
      harnessRevisionTiming: "after-first-run",
      harnessRevisionTimingNote:
        "a first run exposed harness defects (a brittle DOM lookup and a trim mismatch), which were then revised and re-locked with the verdicts unchanged",
    },
    {
      id: "moodplays",
      label: "MoodPlays",
      rootAbs: join(skeletonAbs, "moodplays"),
      rootRel: `${skeletonRel}/moodplays`,
      anchorLockName: "property-1.claim-24h-to-minutes.lock.json",
      executionResultName: "execute-properties-all.json",
      replayResultName: "replay-property-1.claim-24h-to-minutes.json",
      fixResultName: "apply-fixes-reexecute-all.json",
      // From moodplays/locks/superseded/README.md: "All were caught by REVIEW,
      // before any execution (no Stage C has run)." — all 5 before any run.
      harnessRevisionTiming: "before-any-execution",
      harnessRevisionTimingNote:
        "all 5 restated the implementation and were rewritten with independent oracles before any execution",
    },
  ];

  const readers = makeRealReaders(repoRoot);
  const asset = await buildSectionsAsset(readers, targets);

  const outDir = join(uiRoot, "public", "reports");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, "sections.json");
  await writeFile(outFile, `${JSON.stringify(asset, null, 2)}\n`, "utf8");
  console.log(
    `generated /reports/sections.json (${asset.timelines.length} timeline(s), ` +
      `${asset.honesty.length} honesty item(s))`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
