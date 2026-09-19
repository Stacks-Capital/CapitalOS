import { defineConfig } from "vite";

// 5173 is reserved for Playwright (the fixture's canonical origin). Local dev uses 5180 so a
// taken 5173 does not silently move the app onto the other tenant's origin.
export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
  },
});
