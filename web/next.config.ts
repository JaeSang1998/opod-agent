import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  experimental: {
    // Shared Node ESM source uses explicit `.js` specifiers; resolve those to
    // TypeScript while the playground consumes the protocol directly.
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
  },
  turbopack: {
    root: dirname(dirname(fileURLToPath(import.meta.url))),
  },
};

export default nextConfig;
