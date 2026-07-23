import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: dirname(dirname(fileURLToPath(import.meta.url))),
  },
};

export default nextConfig;
