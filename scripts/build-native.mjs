import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

if (process.platform !== "darwin") {
  console.log("native: skipped (desktop helper is macOS-only)");
  process.exit(0);
}

const src = "native/macos/ax.swift";
const out = "dist/native/agentcursor-ax";
mkdirSync("dist/native", { recursive: true });

const swiftc = (target, file) =>
  execFileSync("xcrun", ["swiftc", "-O", "-swift-version", "5", "-target", target, "-o", file, src], { stdio: "inherit" });

try {
  swiftc("arm64-apple-macos12", `${out}-arm64`);
  swiftc("x86_64-apple-macos12", `${out}-x86_64`);
  execFileSync("lipo", ["-create", "-output", out, `${out}-arm64`, `${out}-x86_64`]);
  console.log(`native: built universal ${out}`);
} catch {
  swiftc(`${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12`, out);
  console.log(`native: built host-arch ${out}`);
} finally {
  rmSync(`${out}-arm64`, { force: true });
  rmSync(`${out}-x86_64`, { force: true });
}
