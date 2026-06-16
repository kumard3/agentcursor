// End-to-end run: a real MCP client (over stdio) drives the real built server,
// while a simulated browser stands in for the extension at the WebSocket. This
// exercises the full pipeline MCP -> server -> human-path engine -> driver -> WS.
// A live Chrome with the unpacked extension is the only piece not covered here.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

const PORT = process.env.SMOKE_PORT ?? "8799";
const WS_URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SNAPSHOT = {
  url: "https://example.com/login",
  title: "Example Login",
  viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, devicePixelRatio: 2 },
  elements: [
    { ref: "e1", tag: "input", role: "email", name: "email", rect: { x: 560, y: 280, width: 280, height: 40 }, editable: true },
    { ref: "e2", tag: "button", role: "button", name: "Sign in", rect: { x: 560, y: 360, width: 160, height: 44 }, editable: false },
  ],
  text: "Sign in to Example",
};

const captured = { commands: [], lastSamples: null };

function answer(command) {
  captured.commands.push(command.kind);
  switch (command.kind) {
    case "cursorState": return { x: 30, y: 40 };
    case "windowGeometry": return { screenX: 0, screenY: 0, innerWidth: 1280, innerHeight: 720, outerWidth: 1280, outerHeight: 800, devicePixelRatio: 2 };
    case "snapshot": return SNAPSHOT;
    case "getUrl": return SNAPSHOT.url;
    case "waitFor": return true;
    case "screenshot": return "data:image/png;base64,FAKE";
    case "hover": 
    case "ensureVisible":
    case "drag": return null;
    case "replayMove":
    case "replayClick": captured.lastSamples = command.samples; return null;
    default: return null;
  }
}

async function connectFakeExtension() {
  for (let i = 0; i < 40; i++) {
    const ws = new WebSocket(WS_URL);
    const open = await new Promise((res) => {
      ws.once("open", () => res(true));
      ws.once("error", () => res(false));
    });
    if (open) {
      ws.on("message", (raw) => {
        const env = JSON.parse(raw.toString());
        if (!env.command) return;
        ws.send(JSON.stringify({ id: env.id, ok: true, data: answer(env.command) }));
      });
      return ws;
    }
    await sleep(150);
  }
  throw new Error(`fake extension could not connect to ${WS_URL}`);
}

function straightnessOf(samples) {
  if (!samples || samples.length < 2) return 1;
  const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  let len = 0;
  for (let i = 1; i < samples.length; i++) len += d(samples[i - 1], samples[i]);
  return d(samples[0], samples.at(-1)) / len;
}

function pathReport(samples) {
  if (!samples?.length) return "no samples";
  return `${samples.length} samples over ${Math.round(samples.at(-1).t)}ms, straightness ${straightnessOf(samples).toFixed(3)} (1.000 = robotic straight line)`;
}

const text = (r) => r.content?.map((c) => c.text).join("") ?? "";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, AGENTCURSOR_WS_PORT: PORT, AGENTCURSOR_DRIVER: "extension" },
    stderr: "inherit",
  });
  const client = new Client({ name: "agentcursor-smoke", version: "0.0.0" });
  await client.connect(transport);
  console.log("✓ MCP client connected to server over stdio");

  const ext = await connectFakeExtension();
  console.log("✓ simulated browser connected over WebSocket\n");

  const tools = await client.listTools();
  console.log(`tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(", ")}\n`);

  const page = await client.callTool({ name: "read_page", arguments: {} });
  console.log("read_page →");
  console.log(text(page).split("\n").slice(0, 6).join("\n"), "\n");

  const click = await client.callTool({ name: "click", arguments: { ref: "e2" } });
  console.log(`click e2 → ${text(click)}`);
  console.log(`   live cursor path: ${pathReport(captured.lastSamples)}\n`);

  console.log(`type e1 → ${text(await client.callTool({ name: "type", arguments: { ref: "e1", text: "hello@example.com" } }))}`);
  console.log(`hover e2 → ${text(await client.callTool({ name: "hover", arguments: { ref: "e2" } }))}`);
  console.log(`scroll → ${text(await client.callTool({ name: "scroll", arguments: { dy: 600 } }))}`);
  console.log(`get_url → ${text(await client.callTool({ name: "get_url", arguments: {} }))}`);
  console.log(`wait_for → ${text(await client.callTool({ name: "wait_for", arguments: { text: "Sign in" } }))}`);
  const shot = await client.callTool({ name: "screenshot", arguments: {} });
  console.log(`screenshot → received data URL (length ${text(shot).length})`);
  console.log(`status →\n${text(await client.callTool({ name: "status", arguments: {} }))}\n`);

  console.log(`commands the browser received: ${captured.commands.join(", ")}`);

  const samples = captured.lastSamples ?? [];
  const checks = {
    "12+ tools registered": tools.tools.length >= 12,
    "cursor path generated": samples.length > 8,
    "path is curved, not straight": straightnessOf(samples) < 0.999,
    "timing starts at 0": samples[0]?.t === 0,
    "screenshot returned data": text(shot).startsWith("data:image"),
  };

  await client.close();
  ext.close();

  console.log("");
  let allOk = true;
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? "✓" : "✗"} ${name}`);
    allOk &&= pass;
  }
  if (!allOk) process.exit(1);
  console.log("\n✓ end-to-end pipeline OK (MCP → server → human-path engine → browser)");
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke error:", e);
  process.exit(1);
});
