import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // With TEST_DATABASE_URL the integration suites share one physical queue
    // table; parallel files would claim/clean each other's live rows. Serial
    // files keep them deterministic. Without the env var (pure unit runs)
    // parallelism stays on.
    fileParallelism: !process.env.TEST_DATABASE_URL,
    coverage: {
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        "src/testing/**",
        // The DB adapters are covered by TEST_DATABASE_URL-gated integration
        // tests. Where that env is absent (CI has no Postgres) those tests skip,
        // so the files leave the coverage denominator symmetrically; with the
        // env set they are measured and gated as usual.
        ...(process.env.TEST_DATABASE_URL
          ? []
          : [
              "src/memory/postgres-memory-store.ts",
              "src/memory/postgres-job-queue.ts",
              "src/memory/consolidation-worker.ts",
            ]),
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 80,
        functions: 85,
        lines: 90,
        statements: 90,
      },
    },
  },
});
