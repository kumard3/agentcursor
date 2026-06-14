import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  platform: "node",
  format: "esm",
  bundle: true,
  packages: "external",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
});

console.log("built dist/index.js");
