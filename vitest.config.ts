import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // node is the default environment. Component tests opt into jsdom with a
    // `// @vitest-environment jsdom` pragma at the top of the file, so jsdom
    // is available everywhere without paying its cost in pure-logic tests.
    environment: "node",
    globals: false,
    // Shared setup enforces the fast-check minimum of 100 iterations.
    setupFiles: ["./vitest.setup.ts"],
    include: ["packages/**/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
