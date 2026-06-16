// Verifies a REAL loaded extension: starts a server on 8930, connects an MCP
// client, and calls read_page. The extension (auto-reconnecting) joins our
// server and reports the live focused tab. Proves install + wiring end to end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content?.map((c) => c.text).join("") ?? "";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, AGENTCURSOR_DRIVER: "extension" },
  stderr: "inherit",
});
const client = new Client({ name: "verify-live", version: "0.0.0" });
await client.connect(transport);
console.log("local server up on 8930; waiting for the loaded extension to connect...");

let out = null;
let lastErr = "";
for (let i = 0; i < 25; i++) {
  try {
    const r = await client.callTool({ name: "read_page", arguments: { maxElements: 15 } });
    const body = text(r);
    if (r.isError) {
      lastErr = body;
      if (/content script is not present/i.test(body)) break;
      process.stdout.write(".");
      await sleep(1000);
      continue;
    }
    out = body;
    break;
  } catch (e) {
    lastErr = String(e?.message ?? e);
    process.stdout.write(".");
    await sleep(1000);
  }
}
console.log("");

if (out) {
  console.log("✓ EXTENSION INSTALLED, CONNECTED, AND READING THE LIVE TAB:\n");
  console.log(out.split("\n").slice(0, 16).join("\n"));
} else if (/content script is not present/i.test(lastErr)) {
  console.log("~ Extension IS connected, but the focused tab has no content script");
  console.log("  (it's a chrome:// or Web Store page). Focus your http://localhost:8080");
  console.log("  tab and re-run: pnpm exec node scripts/verify-live.mjs");
} else {
  console.log(`✗ Extension did not connect within 25s. Last error: ${lastErr}`);
  console.log("  Check chrome://extensions: AgentCursor enabled; click its 'service worker'");
  console.log("  link and look for: [agentcursor] connected to MCP server");
}

await client.close();
process.exit(out ? 0 : 1);
