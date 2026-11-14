#!/usr/bin/env node
/**
 * package-power.mjs — generate a STANDALONE Kiro Power folder at
 * out/spec-lantern-power/ (gitignored), ready to publish later as its own
 * GitHub repo (ikenyal/spec-lantern-power).
 *
 * The published Power must install with NO build step: when a user imports it
 * from GitHub, `npx -y github:ikenyal/spec-lantern-power#<tag>` runs the `bin`
 * directly. So the MCP server is bundled here into a SINGLE self-contained file
 * (dist/server.mjs) with esbuild — platform node, every dependency inlined —
 * and no `prepare`/`postinstall` ever runs on the user's machine.
 *
 * What ships in the folder:
 *   - POWER.md              (copied from packages/kiro-power, at the root)
 *   - steering/             (copied from packages/kiro-power/steering)
 *   - mcp.json              (npx-from-GitHub launch; no cwd; no autoApprove for
 *                            apply_fixes_and_reexecute)
 *   - package.json          (bin -> dist/server.mjs, engines node>=20, type module)
 *   - dist/server.mjs       (the whole MCP server bundled into one file)
 *   - README.md             (requirements, install, how to ask Kiro, safety model)
 *   - LICENSE               (MIT, copied)
 *
 * RUNTIME DATA FILES: the MCP server reads NO external data files at runtime.
 * Verified by grepping the server's source (src/mcp-server.ts and everything it
 * imports): the tools take their inputs as parameters (targetRepoRef,
 * specRoot, properties, ...); the runner emits every vitest config, setup
 * module, and stub as INLINE string constants (WORKTREE_*, COMPONENT_RENDER_*,
 * SEED_* builders); and the Verdaccio proxy runs the stock
 * `docker.io/verdaccio/verdaccio:6` image with its default config (no mounted
 * config file). The only `import.meta.url`/REPO_ROOT/sandbox reads live in
 * src/execute-path.ts (the walking-skeleton demo path), which the server entry
 * does NOT import. So a single bundled server.mjs is complete — nothing else is
 * needed at install time.
 */
import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const OUT_DIR = resolve(repoRoot, "out", "spec-lantern-power");
const POWER_PKG = resolve(repoRoot, "packages", "kiro-power");
const MCP_PKG = resolve(repoRoot, "packages", "mcp-server");

/** The GitHub ref the published mcp.json launches with `npx -y`. */
const GITHUB_SPEC = "github:ikenyal/spec-lantern-power#v0.1.0";
const POWER_VERSION = "0.1.0";

function log(msg) {
  process.stdout.write(`[package:power] ${msg}\n`);
}

async function main() {
  // 1. Fresh output dir.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(join(OUT_DIR, "dist"), { recursive: true });
  log(`cleaned + created ${OUT_DIR}`);

  // 2. Copy POWER.md (root) and steering/.
  await cp(join(POWER_PKG, "POWER.md"), join(OUT_DIR, "POWER.md"));
  await cp(join(POWER_PKG, "steering"), join(OUT_DIR, "steering"), {
    recursive: true,
  });
  log("copied POWER.md + steering/");

  // 3. Copy the MIT LICENSE verbatim.
  await cp(join(repoRoot, "LICENSE"), join(OUT_DIR, "LICENSE"));
  log("copied LICENSE");

  // 4. Bundle the MCP server into ONE self-contained file with esbuild:
  //    platform node, ESM, every dependency inlined (nothing marked external),
  //    so the published package installs with no deps and no build step.
  const entry = join(MCP_PKG, "src", "bin", "server.ts");
  const outfile = join(OUT_DIR, "dist", "server.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // Everything inlined — no externals. With `bundle: true` and nothing marked
    // external, esbuild inlines every dependency, so the result is a single file
    // that runs with only Node 20+ and no node_modules.
    banner: {
      // esbuild ESM output can reference require()/__dirname from inlined CJS
      // deps (e.g. the MCP SDK). Shim them so the single ESM file still runs.
      js: [
        "import { createRequire as __spec_lantern_createRequire } from 'node:module';",
        "import { fileURLToPath as __spec_lantern_fileURLToPath } from 'node:url';",
        "import { dirname as __spec_lantern_dirname } from 'node:path';",
        "const require = __spec_lantern_createRequire(import.meta.url);",
        "const __filename = __spec_lantern_fileURLToPath(import.meta.url);",
        "const __dirname = __spec_lantern_dirname(__filename);",
      ].join("\n"),
    },
    logLevel: "info",
  });
  log(`bundled MCP server -> ${outfile}`);

  // 5. package.json — bin points at the bundled server; engines node>=20; no
  //    deps (everything is inlined) so `npx -y github:...` needs no install.
  const pkg = {
    name: "spec-lantern-power",
    version: POWER_VERSION,
    description:
      "spec-lantern Kiro Power — revive vibe-coded TypeScript/React apps by " +
      "executing every claimed behavior instead of trusting comments.",
    license: "MIT",
    type: "module",
    bin: {
      "spec-lantern-power": "./dist/server.mjs",
    },
    engines: {
      node: ">=20",
    },
    files: ["dist", "steering", "POWER.md", "mcp.json", "README.md", "LICENSE"],
  };
  await writeFile(
    join(OUT_DIR, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
    "utf8",
  );
  log("wrote package.json");

  // 6. mcp.json — the PUBLISHED launch. `npx -y github:...#tag` fetches and runs
  //    the bin (dist/server.mjs) directly; no cwd is set (the server resolves
  //    nothing relative to it); PATH is pinned so Podman on the user's
  //    Homebrew/standard paths is found. apply_fixes_and_reexecute is
  //    deliberately NOT auto-approved — it writes to a copy and re-executes, so
  //    the user confirms it each time.
  const mcp = {
    mcpServers: {
      "spec-lantern": {
        command: "npx",
        args: ["-y", GITHUB_SPEC],
        env: {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        },
        disabled: false,
        autoApprove: [
          "lock_prediction",
          "supersede_prediction_lock",
          "execute_properties",
          "replay_counterexample",
        ],
      },
    },
  };
  await writeFile(
    join(OUT_DIR, "mcp.json"),
    JSON.stringify(mcp, null, 2) + "\n",
    "utf8",
  );
  log("wrote mcp.json");

  // 7. README.md.
  await writeFile(join(OUT_DIR, "README.md"), README, "utf8");
  log("wrote README.md");

  log(`done. Standalone Power at ${OUT_DIR}`);
}

const README = `# spec-lantern Kiro Power

Revive abandoned "vibe-coded" TypeScript/React apps. spec-lantern reverse-engineers
a Kiro spec, turns every claim a comment makes into an **executable
Correctness_Property**, locks a read-only prediction, then **executes** the
properties in an isolated runner and compares predicted vs actual. The guiding
rule: an agent that only *reads* code trusts misleading comments — so this Power
never stops at reading.

- Demo video (2 min): https://youtu.be/H2C7ndx9C8c
- Live report and the "Trust or Test?" game: https://d2xayupxggkiqt.cloudfront.net/
- Source, spec and design: https://github.com/ikenyal/spec-lantern
- Kiroween 2026 submission: https://devpost.com/software/spec-lantern

[![spec-lantern demo video](https://img.youtube.com/vi/H2C7ndx9C8c/maxresdefault.jpg)](https://youtu.be/H2C7ndx9C8c)

## Requirements

- **Kiro** (the AI IDE that loads Powers).
- **Node.js 20 or newer** — the bundled MCP server is launched with \`npx\`.
- **rootless Podman** — the server runs all target code inside Podman, never on
  your host. On macOS, start the Podman machine first:

  \`\`\`sh
  brew install podman        # if not installed
  podman machine init        # first time only
  podman machine start
  \`\`\`

## Install

In Kiro:

1. Open **Powers**.
2. **Add Custom Power** -> **Import power from GitHub**.
3. Paste \`https://github.com/ikenyal/spec-lantern-power\`.

Kiro reads \`POWER.md\` and registers the \`spec-lantern\` MCP server from
\`mcp.json\` (launched with \`npx -y github:ikenyal/spec-lantern-power#v0.1.0\`).
No build step runs — the server ships as one bundled file. Confirm Kiro lists all
six tools (\`lock_prediction\`, \`supersede_prediction_lock\`,
\`execute_properties\`, \`replay_counterexample\`, \`apply_fixes_and_reexecute\`,
\`compare_predictions\`) before you start.

## Use it

Open a TypeScript/React repo in Kiro and just ask, for example:

> Check the comments in this repo — are any of them lying about what the code does?

Kiro activates the Power, reverse-engineers a spec, and runs the
execute-don't-trust pipeline to produce a Lantern_Report of confirmed bugs with
counterexamples.

## Safety model (5 lines)

1. Target code runs **only inside rootless Podman**, never on your host.
2. Dependencies install behind an internal-only network + registry proxy with
   lifecycle scripts disabled; the test phase runs with **no network at all**.
3. The Power itself **never executes** target code — it only writes artifacts
   and calls the six MCP tools.
4. **The original is sacred**: every tool that runs your code
   (\`execute_properties\`, \`replay_counterexample\`, \`apply_fixes_and_reexecute\`)
   first copies the repo into a throwaway working copy and runs against the copy
   — your original repo is never mounted or written to.
5. \`apply_fixes_and_reexecute\` is **not auto-approved** — you confirm every
   fix-and-re-execute run.

## Working copies (where your code is copied to)

Because the original is never mounted, each run copies your repo into a fresh,
throwaway working copy (excluding \`node_modules\`, \`.git\`, and build output) and
removes it when the run finishes. Those copies live under:

- \`$SPEC_LANTERN_WORKDIR\` when that environment variable is set, otherwise
- \`~/.spec-lantern/worktrees\` (created automatically on first use).

The default is anchored to your home directory on purpose: on macOS the Podman
machine shares \`/Users\` but **not** \`/tmp\`, so the copy must live under your
home to be visible inside the container. Set \`SPEC_LANTERN_WORKDIR\` to relocate
the copies (for example to a larger volume), but keep it somewhere Podman can
bind-mount — under your home on macOS.
`;

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[package:power] FAILED: ${message}\n`);
  process.exitCode = 1;
});
