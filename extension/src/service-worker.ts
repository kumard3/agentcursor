import {
  DEFAULT_WS_PORT,
  PROTOCOL_VERSION,
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type DeliveryMode,
  type TabInfo,
  type TabsResult,
} from "../../src/protocol";
import { DebuggerDriver } from "./debugger-driver";
import { log } from "./timing";

const debuggerDriver = new DebuggerDriver();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

type DriveCommand = Extract<Command, { mode: DeliveryMode }>;

// AgentCursor.launch() writes launch.json into its private copy of the
// extension so that instance talks only to its own test's port.
const port: Promise<number> = fetch(chrome.runtime.getURL("launch.json"))
  .then((r) => r.json())
  .then((c: { port: number }) => c.port)
  .catch(() => DEFAULT_WS_PORT);

async function connect(): Promise<void> {
  const PORT = await port;
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
    void connect();
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
    result = { id: env.id, ok: true, data: await route(env.command, env.tab) };
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
  // Don't require Chrome to be the OS-focused window — agents drive it from a
  // terminal, so it's usually backgrounded and lastFocusedWindow returns nothing.
  const isHttp = (t: chrome.tabs.Tab) => /^https?:/.test(t.url ?? "");
  const queries: chrome.tabs.QueryInfo[] = [
    { active: true, lastFocusedWindow: true },
    { active: true },
  ];
  for (const q of queries) {
    const tabs = await chrome.tabs.query(q);
    const tab = tabs.find((t) => t.id != null && isHttp(t)) ?? tabs.find((t) => t.id != null);
    if (tab?.id != null) return tab.id;
  }
  const http = (await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })).find(
    (t) => t.id != null,
  );
  if (http?.id != null) return http.id;
  throw new Error("No active tab found. Open a normal http(s) tab in Chrome.");
}

async function pinnedTab(id: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(id);
  } catch {
    throw new Error(`Tab ${id} is closed. Call tabs to pick another.`);
  }
}

function tabInfo(t: chrome.tabs.Tab): TabInfo {
  return { id: t.id!, title: t.title ?? "", url: t.url ?? "", active: t.active };
}

async function tabs(
  cmd: Extract<Command, { kind: "tabs" }>,
  pinned: number | undefined,
): Promise<TabsResult> {
  const list = async () => (await chrome.tabs.query({})).filter((t) => t.id != null).map(tabInfo);
  if (cmd.action === "new") {
    const tab = await chrome.tabs.create({ active: false });
    if (cmd.url) await navigateAndWait(tab.id!, cmd.url);
    return { tabs: await list(), pin: tab.id! };
  }
  if (cmd.action === "close") {
    const id = cmd.id ?? pinned;
    if (id == null) throw new Error("Nothing to close: pass id, or select a tab first.");
    await chrome.tabs.remove(id);
    return { tabs: await list(), ...(id === pinned ? { pin: null } : {}) };
  }
  const all = await list();
  if (cmd.action === "list") return { tabs: all };
  if (cmd.id == null && !cmd.url) return { tabs: all, pin: null };
  const q = cmd.url?.toLowerCase() ?? "";
  const hit =
    cmd.id != null
      ? all.find((t) => t.id === cmd.id)
      : (all.find((t) => t.url.toLowerCase().includes(q)) ?? all.find((t) => t.title.toLowerCase().includes(q)));
  if (!hit) throw new Error(`No tab matches ${cmd.id ?? `"${cmd.url}"`}.`);
  return { tabs: all, pin: hit.id };
}

async function route(cmd: Command, pinned?: number): Promise<unknown> {
  if (cmd.kind === "tabs") return tabs(cmd, pinned);
  const tabId = pinned != null ? (await pinnedTab(pinned)).id! : await activeTabId();
  if (cmd.kind === "screenshot" || cmd.kind === "windowGeometry") {
    // Both only see the visible tab: a background pin would capture, or OS-click, the user's tab.
    if (!(await chrome.tabs.get(tabId)).active) {
      throw new Error(`Tab ${tabId} is in the background, so ${cmd.kind} cannot see it. read_page and find work there.`);
    }
  }
  if (cmd.kind === "navigate") {
    await navigateAndWait(tabId, cmd.url);
    return null;
  }
  if (cmd.kind === "getUrl") {
    const tab = await chrome.tabs.get(tabId);
    return tab.url ?? "";
  }
  if (cmd.kind === "screenshot") {
    const format = cmd.format ?? "png";
    // Headless hands back the previous frame unless a paint happens first.
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      })
      .catch(() => undefined);
    const dataUrl = await chrome.tabs.captureVisibleTab({ format });
    try {
      const geom = (await sendToContent(tabId, { kind: "windowGeometry" })) as {
        innerWidth: number;
        innerHeight: number;
      };
      return await scaleToViewport(dataUrl, geom.innerWidth, geom.innerHeight, format);
    } catch {
      return dataUrl;
    }
  }
  if (cmd.kind === "hover" || cmd.kind === "ensureVisible") {
    // Hover and ensureVisible go via content (for DOM scrollIntoView + events)
    return sendToContent(tabId, cmd);
  }
  if (cmd.kind === "startScreencast") {
    await debuggerDriver.startScreencast(tabId, cmd, (frame) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            event: "screencastFrame",
            data: frame.data,
            metadata: frame.metadata,
          }),
        );
      }
    });
    return null;
  }
  if (cmd.kind === "stopScreencast") {
    await debuggerDriver.stopScreencast(tabId);
    return null;
  }
  if (cmd.kind === "evaluate") {
    // CDP Runtime.evaluate: page realm (page cookies + globals), awaits
    // promises, and bypasses the page CSP the way DevTools does.
    return debuggerDriver.evaluate(tabId, cmd.expression);
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
    cmd.kind === "drag" ||
    cmd.kind === "pressKey"
  );
}

// Downscale the device-pixel capture to CSS viewport size so 1 image pixel == 1 click coordinate.
async function scaleToViewport(
  dataUrl: string,
  w: number,
  h: number,
  format: "png" | "jpeg",
): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const out = await canvas.convertToBlob({ type: mime });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

function navigateAndWait(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, 15_000);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch((err) => {
      done();
      reject(err);
    });
  });
}

async function sendToContent(tabId: number, cmd: Command): Promise<unknown> {
  const env: CommandEnvelope = { v: PROTOCOL_VERSION, id: "", command: cmd };
  let res: { ok: boolean; data?: unknown; error?: string } | undefined;
  // The content script lands at document_idle, so right after a navigation
  // (goto, or a click that follows a link) it can be briefly absent.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      res = await chrome.tabs.sendMessage(tabId, env);
      break;
    } catch (err) {
      const absent = /Receiving end does not exist/.test(String(err));
      if (!absent || Date.now() >= deadline) {
        throw new Error(
          "AgentCursor content script is not present on this tab (chrome:// and Web Store pages are not supported).",
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!res) throw new Error("No response from page");
  if (!res.ok) throw new Error(res.error ?? "content script error");
  return res.data;
}

chrome.alarms.create("agentcursor-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!socket || socket.readyState === WebSocket.CLOSED) void connect();
});

void connect();
