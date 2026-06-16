import {
  DEFAULT_WS_PORT,
  PROTOCOL_VERSION,
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type DeliveryMode,
} from "../../src/protocol";
import { DebuggerDriver } from "./debugger-driver";
import { log } from "./timing";

const PORT = DEFAULT_WS_PORT;
const debuggerDriver = new DebuggerDriver();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

type DriveCommand = Extract<Command, { mode: DeliveryMode }>;

function connect(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
  socket.addEventListener("open", () =>
    log("connected to MCP server"),
  );
  socket.addEventListener("message", (ev) => onCommand(String(ev.data)));
  socket.addEventListener("close", () => {
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1500);
}

async function onCommand(raw: string): Promise<void> {
  let env: CommandEnvelope;
  try {
    env = JSON.parse(raw) as CommandEnvelope;
  } catch {
    return;
  }
  if (!env?.command) return;
  let result: CommandResult;
  try {
    result = { id: env.id, ok: true, data: await route(env.command) };
  } catch (err) {
    result = {
      id: env.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(result));
  }
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

async function route(cmd: Command): Promise<unknown> {
  const tabId = await activeTabId();
  if (cmd.kind === "navigate") {
    await chrome.tabs.update(tabId, { url: cmd.url });
    return null;
  }
  if (cmd.kind === "getUrl") {
    const tab = await chrome.tabs.get(tabId);
    return tab.url ?? "";
  }
  if (cmd.kind === "screenshot") {
    const format = cmd.format ?? "png";
    const dataUrl = await chrome.tabs.captureVisibleTab({ format });
    return dataUrl;
  }
  if (cmd.kind === "hover" || cmd.kind === "ensureVisible") {
    // Hover and ensureVisible go via content (for DOM scrollIntoView + events)
    return sendToContent(tabId, cmd);
  }
  if (isDrive(cmd) && cmd.mode === "debugger") {
    return debuggerDriver.handle(tabId, cmd);
  }
  return sendToContent(tabId, cmd);
}

function isDrive(cmd: Command): cmd is DriveCommand {
  return (
    cmd.kind === "replayMove" ||
    cmd.kind === "replayClick" ||
    cmd.kind === "type" ||
    cmd.kind === "scroll" ||
    cmd.kind === "drag"
  );
}

async function sendToContent(tabId: number, cmd: Command): Promise<unknown> {
  const env: CommandEnvelope = { v: PROTOCOL_VERSION, id: "", command: cmd };
  let res: { ok: boolean; data?: unknown; error?: string } | undefined;
  try {
    res = await chrome.tabs.sendMessage(tabId, env);
  } catch {
    throw new Error(
      "AgentCursor content script is not present on this tab (chrome:// and Web Store pages are not supported).",
    );
  }
  if (!res) throw new Error("No response from page");
  if (!res.ok) throw new Error(res.error ?? "content script error");
  return res.data;
}

chrome.alarms.create("agentcursor-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!socket || socket.readyState === WebSocket.CLOSED) connect();
});

connect();
