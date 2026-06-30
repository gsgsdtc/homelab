import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      all: true,
      include: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
      reporter: ["text"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    },
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"]
  },
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname
    }
  }
});
