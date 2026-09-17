import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = process.env.AGENTCURSOR_HTTP_PORT ?? "8931";
const client = new Client({ name: "desktop-live", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
const text = (r) => r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
const call = async (name, args = {}) => {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const out = text(r);
  console.log(`\n→ ${name} ${JSON.stringify(args)} (${Date.now() - t}ms)${r.isError ? " ERROR" : ""}\n${out.split("\n").slice(0, 14).join("\n")}`);
  return { r, out };
};

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")}`);

await call("desktop_apps");
const finder = await call("desktop_read", { app: "Finder" });
console.log(`[finder read: ${finder.out.length} chars, ${finder.out.split("\n").length} lines]`);
const shot = await call("desktop_screenshot", { app: "Finder" });
const img = shot.r.content.find((c) => c.type === "image");
console.log(`[finder screenshot: ${img?.mimeType}, ${img?.data.length} base64 chars]`);
await call("desktop_move", { text: "Downloads", app: "Finder" });

await call("desktop_open", { app: "TextEdit" });
await call("desktop_key", { keys: "cmd+n" });
await new Promise((r) => setTimeout(r, 800));
await call("desktop_type", { text: "Hello from AgentCursor." });
const doc = await call("desktop_read", { find: "Hello" });
await call("desktop_key", { keys: "cmd+w" });
await new Promise((r) => setTimeout(r, 800));
const sheet = await call("desktop_read", { find: "Delete" });
if (/\[d\d+\] button "Delete"/.test(sheet.out)) await call("desktop_click", { text: "Delete" });
const after = await call("desktop_read", { find: "Hello" });

const checks = {
  "desktop tools registered": tools.tools.filter((t) => t.name.startsWith("desktop_")).length === 9,
  "finder read returns refs": /\[d1\]/.test(finder.out),
  "screenshot is an image": Boolean(img?.data),
  "typed text visible in TextEdit": /Hello from AgentCursor/.test(doc.out),
  "document closed without saving": !/Hello from AgentCursor/.test(after.out),
};
console.log("");
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "✓" : "✗"} ${k}`);
await client.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
