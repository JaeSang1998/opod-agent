import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evals/**/*.test.ts"],
    coverage: {
      exclude: ["evals/**/*.test.ts"],
      // The closed-loop target/CLI receive Docker + Harbor preflight coverage;
      // this unit gate protects the scoring, schemas, ATIF, and structured LLM
      // contracts that can otherwise produce a false certificate.
      include: ["evals/{atif,evaluate,llm,review,schema}.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 75,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
  },
});
