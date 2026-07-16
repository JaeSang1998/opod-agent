import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "@opod/protocol": fileURLToPath(new URL("../src/protocol/index.ts", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
      include: [
        "app/api/**/*.ts",
        "backend/**/*.ts",
        "chat/openai-sse.ts",
        "chat/prompt-input.tsx",
        "chat/use-consolidation.ts",
      ],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 90,
        statements: 90,
      },
    },
  },
});
