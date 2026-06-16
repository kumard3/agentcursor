// Live interactive test: starts a server, waits for the loaded extension, then
// drives human-cursor clicks on the detector page so you can watch in Arc.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content?.map((c) => c.text).join("") ?? "";
const urlOf = (s) => (s.match(/^URL:\s*(.*)$/m)?.[1] ?? "").trim();

function parse(snapshot) {
  const els = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/^\s*\[(\w+)\]\s+(\S+)(?:\s+"([^"]*)")?\s+<(\w+)>/);
    if (m) els.push({ ref: m[1], role: m[2], name: m[3] ?? "", tag: m[4] });
  }
  return els;
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, AGENTCURSOR_DRIVER: "extension" },
  stderr: "inherit",
});
const client = new Client({ name: "demo-drive", version: "0.0.0" });
await client.connect(transport);

async function call(name, args, retries = 1, gap = 900) {
  let last = "";
  for (let i = 0; i < retries; i++) {
    const r = await client.callTool({ name, arguments: args });
    const body = text(r);
    if (!r.isError) return body;
    last = body;
    if (i < retries - 1) await sleep(gap);
  }
  throw new Error(`${name}: ${last}`);
}

console.log("waiting for the Arc extension to connect...");
let snap = null;
for (let i = 0; i < 30; i++) {
  try {
    snap = await call("read_page", { maxElements: 40 });
    break;
  } catch {
    process.stdout.write(".");
    await sleep(1000);
  }
}
console.log("");
if (!snap) {
  console.log("✗ extension never connected (enable AgentCursor in Arc, focus a normal tab).");
  await client.close();
  process.exit(1);
}

if (!urlOf(snap).includes("localhost:8080")) {
  console.log(`focused tab is ${urlOf(snap)}`);
  console.log("→ navigating that tab to the detector (http://localhost:8080)...");
  await call("navigate", { url: "http://localhost:8080" });
  await sleep(2800);
  snap = await call("read_page", { maxElements: 40 }, 15, 1000);
}

console.log("✓ detector focused — driving now, watch the cursor in Arc:\n");
const els = parse(snap);

for (const name of ["Submit", "Continue", "Confirm", "Buy now"]) {
  const t = els.find((e) => e.name === name);
  if (!t) continue;
  console.log(`→ human move + click "${name}" [${t.ref}]`);
  await call("click", { ref: t.ref }, 5, 1000);
  await sleep(1800);
}

const input = els.find((e) => e.tag === "input");
if (input) {
  console.log(`→ click + type into the text field [${input.ref}]`);
  await call("type", { ref: input.ref, text: "i am definitely human" }, 5, 1000);
  await sleep(1200);
}

console.log("\n✓ done — check the detector table in Arc; each click row should read 'human-like'.");
await client.close();
process.exit(0);
