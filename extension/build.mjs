import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// `pnpm reload` (AGENTCURSOR_BUMP=1) patch-bumps manifest + package.json +
// plugin.json in lockstep so a chrome://extensions reload is visibly new.
// A plain `pnpm build` leaves versions untouched, so CI and contributors get
// a clean tree.
if (process.env.AGENTCURSOR_BUMP) {
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
}

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
