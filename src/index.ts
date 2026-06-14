import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ActionService } from "./action/service";
import { ExtensionDriver } from "./drivers/extension-driver";
import { DEFAULT_WS_PORT } from "./protocol";
import { ExtensionTransport } from "./server/transport";
import { registerTools } from "./server/tools";

const port = Number(process.env.GHOSTHAND_WS_PORT ?? DEFAULT_WS_PORT);

const wsTransport = new ExtensionTransport(port);
const driver = new ExtensionDriver(wsTransport);
const action = new ActionService(driver);

const server = new McpServer({ name: "ghosthand", version: "0.1.0" });
registerTools(server, action);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `ghosthand: MCP ready (stdio); extension WebSocket on ws://127.0.0.1:${port}\n`,
);
