import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("extension/dist", { recursive: true });

await build({
  entryPoints: ["extension/src/service-worker.ts"],
  outfile: "extension/dist/service-worker.js",
  bundle: true,
  format: "esm",
  target: "chrome116",
});

await build({
  entryPoints: ["extension/src/content.ts"],
  outfile: "extension/dist/content.js",
  bundle: true,
  format: "iife",
  target: "chrome116",
});

console.log("built extension/dist/{service-worker,content}.js");
