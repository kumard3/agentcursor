import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ActionService } from "./action/service";
import type { BrowserDriver } from "./drivers/driver";
import { ExtensionDriver } from "./drivers/extension-driver";
import { OsCursorDriver } from "./drivers/os-cursor-driver";
import { createPersona } from "./persona";
import { DEFAULT_WS_PORT } from "./protocol";
import { ExtensionTransport } from "./server/transport";
import { registerTools } from "./server/tools";

const port = Number(process.env.AGENTCURSOR_WS_PORT ?? DEFAULT_WS_PORT);
const driverKind = (process.env.AGENTCURSOR_DRIVER ?? "extension").toLowerCase();

const seedEnv = process.env.AGENTCURSOR_SEED;
const seed = seedEnv && seedEnv.trim() !== "" && Number.isFinite(Number(seedEnv)) ? Number(seedEnv) : undefined;
const persona = createPersona(seed);

const wsTransport = new ExtensionTransport(port);
const driver: BrowserDriver =
  driverKind === "os"
    ? new OsCursorDriver(wsTransport)
    : new ExtensionDriver(wsTransport);
const action = new ActionService(driver, persona);

function readVersion(): string {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version as string;
  } catch {
    return "0.0.0";
  }
}

const server = new McpServer({ name: "agentcursor", version: readVersion() });
registerTools(server, action);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `agentcursor: MCP ready (stdio, ${driverKind} driver); extension WebSocket on ws://127.0.0.1:${port}\n`,
);
process.stderr.write(
  `agentcursor: persona seed ${persona.seed} (set AGENTCURSOR_SEED=${persona.seed} to reproduce this person)\n`,
);
