import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Auto-bump the patch version each build so a reload's effect is visible in
// chrome://extensions. manifest, package.json and plugin.json stay in lockstep.
const files = [
  "extension/manifest.json",
  "package.json",
  ".claude-plugin/plugin.json",
];
const manifest = JSON.parse(readFileSync(files[0], "utf8"));
const [major, minor, patch] = manifest.version.split(".").map(Number);
const next = `${major}.${minor}.${(patch ?? 0) + 1}`;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  writeFileSync(f, src.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
}
console.log(`version → ${next}`);

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
