import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "@opod/protocol": fileURLToPath(new URL("../src/protocol", import.meta.url)),
    },
  },
});
