import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ActionService } from "./action/service";
import type { BrowserDriver } from "./drivers/driver";
import { ExtensionDriver } from "./drivers/extension-driver";
import { OsCursorDriver } from "./drivers/os-cursor-driver";
import { DEFAULT_WS_PORT } from "./protocol";
import { ExtensionTransport } from "./server/transport";
import { registerTools } from "./server/tools";

const port = Number(process.env.AGENTCURSOR_WS_PORT ?? DEFAULT_WS_PORT);
const driverKind = (process.env.AGENTCURSOR_DRIVER ?? "extension").toLowerCase();

const wsTransport = new ExtensionTransport(port);
const driver: BrowserDriver =
  driverKind === "os"
    ? new OsCursorDriver(wsTransport)
    : new ExtensionDriver(wsTransport);
const action = new ActionService(driver);

const server = new McpServer({ name: "agentcursor", version: "0.2.0" });
registerTools(server, action);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `agentcursor: MCP ready (stdio, ${driverKind} driver); extension WebSocket on ws://127.0.0.1:${port}\n`,
);

// Re-exports for programmatic / "API" use in tests, custom automation, and workflows.
// Example: import { ActionService, generateMove, createRng } from "agentcursor";
export { ActionService } from "./action/service";
export { generateMove, offCenterPoint, sampleDwellMs, samplePressMs, sampleKeyDelayMs, createRng } from "./path-engine";
export type { BrowserDriver } from "./drivers/driver";
export { ExtensionDriver } from "./drivers/extension-driver";
export { OsCursorDriver } from "./drivers/os-cursor-driver";
export type { Point, PageSnapshot, PageElement, CursorSample } from "./protocol";

// Optional HTTP API mode for non-MCP consumers (Phase 3)
// Set AGENTCURSOR_HTTP_PORT=8931 to enable simple POST /call {name, args}
import * as http from "http";
const httpPort = process.env.AGENTCURSOR_HTTP_PORT ? Number(process.env.AGENTCURSOR_HTTP_PORT) : 0;
if (httpPort) {
  const httpServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/call") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { name, args = {} } = JSON.parse(body || "{}");
          // Minimal dispatch for key tools (full via MCP recommended)
          let result: any = { note: "HTTP stub - prefer MCP for full tool surface" };
          if (name === "get_url") result = await action.getUrl();
          if (name === "status") result = "ok (see MCP status tool)";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
    } else {
      res.writeHead(404);
      res.end("use POST /call for tools or use MCP stdio");
    }
  });
  httpServer.listen(httpPort, "127.0.0.1", () => {
    process.stderr.write(`agentcursor: HTTP API listening on 127.0.0.1:${httpPort} (POST /call)\n`);
  });
}
