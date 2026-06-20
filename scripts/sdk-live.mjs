// Live SDK test against a real Chrome + the loaded extension.
// Serves test-detector/showcase.html, drives it with the AgentCursor SDK, and
// verifies each action registered in the page (banner / form log / submenu).
//
// Prereqs:
//   1. pnpm build, then reload the agentcursor extension at chrome://extensions.
//   2. Free port 8930 for the SDK (turn the agentcursor MCP server off).
//   3. pnpm exec http-server or: python3 -m http.server 8123 --directory test-detector
// Run:  node scripts/sdk-live.mjs
import net from "node:net";
import { AgentCursor } from "../dist/lib.js";

const PORT = Number(process.env.AGENTCURSOR_WS_PORT ?? 8930);
const PAGE = process.env.LIVE_URL ?? "http://localhost:8123/showcase.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}
async function waitForPortFree(port, ms) {
  const deadline = Date.now() + ms;
  while (await portInUse(port)) {
    if (Date.now() >= deadline) {
      throw new Error(`port ${port} still in use after ${ms}ms — turn off the agentcursor MCP server so the SDK can bind it`);
    }
    process.stdout.write(`waiting for port ${port} to free (turn the agentcursor MCP server off)…\n`);
    await sleep(1500);
  }
}

const results = [];
function check(name, pass, extra = "") {
  results.push(pass);
  console.log(`${pass ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
}
const banner = (ac) => ac.locator("#banner").textContent().then((t) => t ?? "");
const formlog = (ac) => ac.locator("#formlog").textContent().then((t) => t ?? "");

async function main() {
  console.log(`live SDK test → ${PAGE} on ws:${PORT}`);
  await waitForPortFree(PORT, 300_000);
  const ac = await AgentCursor.connect({ port: PORT, stealth: false, timeoutMs: 30_000 });
  console.log("✓ extension connected to the SDK\n");
  try {
    await ac.navigate(PAGE);
    await sleep(1500);
    check("navigated to showcase", (await ac.url()).includes("showcase.html"), await ac.url());

    const btnCount = await ac.getByRole("button").count();
    check("getByRole('button').count() >= 5", btnCount >= 5, `(got ${btnCount})`);

    const box = await ac.getByText("Buy now").boundingBox();
    check("getByText('Buy now').boundingBox()", !!box && box.width > 0, JSON.stringify(box));

    await ac.getByRole("button", { name: "Buy now" }).click();
    await sleep(500);
    check("click 'Buy now' registered", (await banner(ac)).includes("Buy now"));

    check("submenu hidden before hover", (await ac.getByText("Settings").isVisible()) === false);
    await ac.getByRole("button", { name: "Menu" }).hover();
    await sleep(600);
    check("hover opened the menu", (await banner(ac)).includes("Menu opened"));
    check("submenu visible after hover", (await ac.getByText("Settings").isVisible()) === true);

    await ac.getByLabel("Email").fill("agent@cursor.dev");
    await sleep(500);
    check("fill Email typed the value", (await banner(ac)).includes("agent@cursor.dev"));

    await ac.getByRole("button", { name: "Submit" }).click();
    await sleep(500);
    check("submit registered", (await formlog(ac)).toLowerCase().includes("submitted"));

    await ac.getByLabel("Message").fill("ship it");
    await ac.getByLabel("Message").press("Enter");
    await sleep(500);
    check("press Enter submitted the form", (await formlog(ac)).includes("Enter"));

    const shot = "/tmp/agentcursor-sdk-live.png";
    await ac.screenshot({ path: shot });
    check("screenshot saved", true, shot);
  } finally {
    await ac.close();
  }
  const allOk = results.every(Boolean);
  console.log(`\n${allOk ? "✓ ALL LIVE CHECKS PASSED" : "✗ some live checks FAILED"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("sdk-live error:", e.message);
  process.exit(1);
});
