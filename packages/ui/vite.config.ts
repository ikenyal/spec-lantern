import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev/demo app for the Lantern_Report_UI. `npm run dev -w @spec-lantern/ui`
// serves index.html, which mounts <LanternReportView> with a sample report
// built from the real writing-tracker result. The package's library build
// (tsc) is unaffected; this config only backs the runnable demo page.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    open: true,
  },
});
