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
