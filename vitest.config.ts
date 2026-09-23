import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests drive a real browser against a real app. Each one signs
    // on, navigates a frameset and reads a grid, which is slower than a unit
    // test and genuinely should be.
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // Browser instances and fixed ports do not share well.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
