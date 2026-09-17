import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { lib: "src/lib.ts" },
    format: ["esm"],
    dts: true,
    clean: ["!native/**"],
    target: "node20",
    outDir: "dist",
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    loader: { ".html": "text" },
    banner: { js: "#!/usr/bin/env node" },
  },
]);
