// Live test on real sites: navigates the focused Arc tab to each site, reads
// the real DOM, human-scrolls, and glides the cursor to real elements. No
// clicks on action buttons (no posting/liking/following) — read+move+scroll
// have no side effects on logged-in accounts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content?.map((c) => c.text).join("") ?? "";
const urlOf = (s) => (s.match(/^URL:\s*(.*)$/m)?.[1] ?? "").trim();
const titleOf = (s) => (s.match(/^Title:\s*(.*)$/m)?.[1] ?? "").trim();

function parse(snapshot) {
  const els = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/^\s*\[(\w+)\]\s+(\S+)(?:\s+"([^"]*)")?\s+<(\w+)>/);
    if (m && m[3]) els.push({ ref: m[1], role: m[2], name: m[3], tag: m[4] });
  }
  return els;
}

const SITES = [
  { name: "Reddit", url: "https://www.reddit.com" },
  { name: "X / Twitter", url: "https://x.com/home" },
];

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, AGENTCURSOR_DRIVER: "extension" },
  stderr: "inherit",
});
const client = new Client({ name: "demo-real", version: "0.0.0" });
await client.connect(transport);

async function call(name, args, retries = 1, gap = 1000) {
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
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    await call("read_page", { maxElements: 5 });
    ready = true;
    break;
  } catch {
    process.stdout.write(".");
    await sleep(1000);
  }
}
console.log("");
if (!ready) {
  console.log("✗ extension never connected.");
  await client.close();
  process.exit(1);
}

for (const site of SITES) {
  console.log(`\n=== ${site.name} (${site.url}) ===`);
  await call("navigate", { url: site.url });
  await sleep(4500); // real sites load slowly
  let snap;
  try {
    snap = await call("read_page", { maxElements: 40 }, 20, 1200);
  } catch (e) {
    console.log(`  could not read ${site.name}: ${String(e.message).slice(0, 120)}`);
    continue;
  }
  console.log(`  read live page: "${titleOf(snap)}" @ ${urlOf(snap)}`);
  const els = parse(snap);
  console.log(`  ${els.length} named interactive elements, e.g.:`);
  for (const e of els.slice(0, 6)) console.log(`    [${e.ref}] ${e.role} "${e.name.slice(0, 40)}"`);

  console.log("  human-scrolling the feed...");
  await call("scroll", { dy: 650 }, 3, 800);
  await sleep(1600);
  await call("scroll", { dy: 650 }, 3, 800);
  await sleep(1600);

  // re-read so element rects are current after scrolling, then glide to a few
  try {
    snap = await call("read_page", { maxElements: 40 }, 5, 1000);
  } catch {
    /* keep the prior snapshot */
  }
  const targets = parse(snap).slice(0, 3);
  for (const t of targets) {
    console.log(`  gliding cursor to [${t.ref}] "${t.name.slice(0, 30)}"`);
    try {
      await call("move_to", { ref: t.ref }, 3, 800);
    } catch {
      /* element may have scrolled away */
    }
    await sleep(1400);
  }
}

console.log("\n✓ done. Read + scroll + cursor glide ran on real sites. No action buttons were clicked.");
await client.close();
process.exit(0);
