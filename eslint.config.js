import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    // Ignore build output, deps, the read-only sandbox target repos, and the
    // gitignored writing-tracker working copy / legacy fixture the Podman
    // execute path (task 4.3) stages and mounts into the container.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "sandbox/**",
      "packages/mcp-server/skeleton/.worktree/**",
      "packages/mcp-server/skeleton/.fixture/**",
      "packages/infra/cdk.out/**",
    ],
  },
  js.configs.recommended,
  {
    // Node runtime globals for server-side code (the MCP server / Podman runner)
    // and Node-run scripts. The type-only `NodeJS` namespace is declared so
    // `NodeJS.Timeout` / `NodeJS.Signals` references resolve under no-undef.
    files: ["packages/mcp-server/**/*.{ts,mjs,js}"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        NodeJS: "readonly",
      },
    },
  },
  {
    // Browser / jsdom globals for the spec-lantern property test files staged
    // into the Isolated_Runner (writing-tracker-full/properties/*.test.ts). These
    // render real React components in jsdom (@testing-library/react), so they
    // reference DOM types like HTMLElement/Element — valid in the container's
    // jsdom environment, declared here so the host lint recognizes them. This is
    // a lint-env declaration only; it never edits the (locked) property sources.
    files: ["packages/mcp-server/skeleton/**/properties/*.test.ts"],
    languageOptions: {
      globals: {
        HTMLElement: "readonly",
        Element: "readonly",
        document: "readonly",
        window: "readonly",
      },
    },
  },
  {
    // Browser globals for the runnable UI demo entry (mounts React into #root
    // and fetches the pre-generated report asset client-side).
    files: ["packages/ui/src/main.tsx"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
      },
    },
  },
  {
    // Node globals for the UI package's Vite config and Node-run build scripts
    // (e.g. the static-report export step, task 19.1).
    files: ["packages/ui/vite.config.ts", "packages/ui/scripts/**/*.ts"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        process: "readonly",
        console: "readonly",
      },
    },
  },
  {
    // Node globals for the AWS CDK infrastructure app (packages/infra). The
    // CDK app entry and stack run under Node (CommonJS via ts-node) and use
    // __dirname / process / console.
    files: ["packages/infra/**/*.ts"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        process: "readonly",
        console: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
