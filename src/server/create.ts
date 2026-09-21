import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActionService } from "../action/service";
import { DesktopService } from "../desktop/service";
import type { BrowserDriver } from "../drivers/driver";
import { ExtensionDriver } from "../drivers/extension-driver";
import { OsCursorDriver } from "../drivers/os-cursor-driver";
import { createPersona, type Persona } from "../persona";
import { DEFAULT_WS_PORT } from "../protocol";
import { registerDesktopTools } from "./desktop-tools";
import { registerTools } from "./tools";
import { ExtensionTransport } from "./transport";

export interface Ports {
  ws: number;
  http: number;
}

export interface Runtime {
  action: ActionService;
  desktop: DesktopService;
  extension: ExtensionTransport;
  persona: Persona;
  ports: Ports;
}

export const SELF = fileURLToPath(import.meta.url);
export const BUILD_ID = Math.round(statSync(SELF).mtimeMs);

export function readVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
}

export function resolvePorts(env = process.env): Ports {
  const ws = Number(env.AGENTCURSOR_WS_PORT ?? DEFAULT_WS_PORT);
  return { ws, http: Number(env.AGENTCURSOR_HTTP_PORT ?? ws + 1) };
}

export function createRuntime(ports: Ports): Runtime {
  const seedEnv = process.env.AGENTCURSOR_SEED;
  const seed = seedEnv && seedEnv.trim() !== "" && Number.isFinite(Number(seedEnv)) ? Number(seedEnv) : undefined;
  const persona = createPersona(seed);
  const extension = new ExtensionTransport(ports.ws);
  const driver: BrowserDriver =
    (process.env.AGENTCURSOR_DRIVER ?? "extension").toLowerCase() === "os"
      ? new OsCursorDriver(extension)
      : new ExtensionDriver(extension);
  return {
    action: new ActionService(driver, persona),
    desktop: new DesktopService(persona, {
      background: process.env.AGENTCURSOR_BACKGROUND === "1",
      showCursor: process.env.AGENTCURSOR_SHOW_CURSOR === "1",
    }),
    extension,
    persona,
    ports,
  };
}

export function createMcpServer(rt: Runtime): McpServer {
  const tools = (process.env.AGENTCURSOR_TOOLS ?? "all").toLowerCase();
  const browser = tools !== "desktop";
  const desktop = tools !== "browser" && process.platform === "darwin";
  const server = new McpServer(
    { name: "agentcursor", version: readVersion() },
    { instructions: instructions(rt.ports, browser, desktop) },
  );
  if (browser) registerTools(server, rt.action);
  if (desktop) registerDesktopTools(server, rt.desktop);
  return server;
}

function instructions(ports: Ports, browser: boolean, desktop: boolean): string {
  return [
    "AgentCursor moves a visible, human-like cursor for you.",
    desktop &&
      "Any Mac app: desktop_open, then desktop_read (compact text with [dN] refs, far cheaper than screenshots), then desktop_click / desktop_type / desktop_key. Use desktop_screenshot only when the text is not enough.",
    browser &&
      "Browser tabs (needs the Chrome extension): read_page, then click / type by [ref], or click_text.",
    `If a tool reports missing permissions or a disconnected extension, send the user to http://127.0.0.1:${ports.http} to finish setup.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const logFile = (port: number): string => join(tmpdir(), `agentcursor-${port}.log`);
