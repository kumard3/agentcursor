// src/protocol/index.ts
var DEFAULT_WS_PORT = 8930;
var PROTOCOL_VERSION = 1;

// extension/src/timing.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
var sleepUntil = (perfTime) => sleep(perfTime - performance.now());
var rand = (min, max) => min + Math.random() * (max - min);
function log(msg) {
  console.log(`[agentcursor] ${msg}`);
}

// extension/src/debugger-driver.ts
function cdpButtonsMask(button) {
  return button === "right" ? 2 : button === "middle" ? 4 : 1;
}
var DebuggerDriver = class {
  attached = /* @__PURE__ */ new Set();
  async handle(tabId, cmd) {
    await this.attach(tabId);
    try {
      switch (cmd.kind) {
        case "replayMove":
          await this.move(tabId, cmd.samples);
          return null;
        case "replayClick":
          await this.move(tabId, cmd.samples);
          await sleep(cmd.preClickDwellMs);
          await this.click(tabId, cmd.target, cmd.button, cmd.dblclick, cmd.pressMs);
          return null;
        case "type":
          await this.type(tabId, cmd.text, cmd.perKeyMinMs, cmd.perKeyMaxMs);
          return null;
        case "scroll":
          await this.scroll(tabId, cmd.dx, cmd.dy, cmd.steps);
          return null;
        case "drag":
          await this.drag(tabId, cmd.samples, cmd.target, cmd.button);
          return null;
        default:
          throw new Error(`debugger driver cannot handle '${cmd.kind}'`);
      }
    } finally {
      await this.detach(tabId);
    }
  }
  async attach(tabId) {
    if (this.attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, "1.3");
    this.attached.add(tabId);
  }
  async detach(tabId) {
    if (!this.attached.has(tabId)) return;
    this.attached.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
    }
  }
  send(tabId, method, params) {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
  async move(tabId, samples) {
    const start = performance.now();
    for (const s of samples) {
      await sleepUntil(start + s.t);
      await this.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: s.x,
        y: s.y
      });
    }
  }
  async click(tabId, target, button, dbl, pressMs) {
    await this.press(tabId, target, button, 1);
    await sleep(pressMs);
    await this.release(tabId, target, button, 1);
    if (dbl) {
      await this.press(tabId, target, button, 2);
      await sleep(pressMs);
      await this.release(tabId, target, button, 2);
    }
  }
  press(tabId, target, button, clickCount) {
    return this.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button,
      buttons: cdpButtonsMask(button),
      clickCount
    });
  }
  release(tabId, target, button, clickCount) {
    return this.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button,
      buttons: 0,
      clickCount
    });
  }
  async type(tabId, text, min, max) {
    for (const ch of text) {
      await this.send(tabId, "Input.insertText", { text: ch });
      await sleep(rand(min, max));
    }
  }
  async scroll(tabId, dx, dy, steps) {
    const count = Math.max(1, steps);
    for (let i = 0; i < count; i++) {
      await this.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 100,
        y: 100,
        deltaX: dx / count,
        deltaY: dy / count
      });
      await sleep(rand(12, 28));
    }
  }
  async drag(tabId, samples, target, button) {
    if (samples.length > 0) {
      await this.move(tabId, samples);
    }
    await this.press(tabId, target, button, 1);
    await sleep(50);
    await this.release(tabId, target, button, 1);
  }
};

// extension/src/service-worker.ts
var PORT = DEFAULT_WS_PORT;
var debuggerDriver = new DebuggerDriver();
var socket = null;
var reconnectTimer = null;
function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
  socket.addEventListener(
    "open",
    () => log("connected to MCP server")
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
    }
  });
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1500);
}
async function onCommand(raw) {
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    return;
  }
  if (!env?.command) return;
  let result;
  try {
    result = { id: env.id, ok: true, data: await route(env.command) };
  } catch (err) {
    result = {
      id: env.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(result));
  }
}
async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}
async function route(cmd) {
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
    return sendToContent(tabId, cmd);
  }
  if (isDrive(cmd) && cmd.mode === "debugger") {
    return debuggerDriver.handle(tabId, cmd);
  }
  return sendToContent(tabId, cmd);
}
function isDrive(cmd) {
  return cmd.kind === "replayMove" || cmd.kind === "replayClick" || cmd.kind === "type" || cmd.kind === "scroll" || cmd.kind === "drag";
}
async function sendToContent(tabId, cmd) {
  const env = { v: PROTOCOL_VERSION, id: "", command: cmd };
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, env);
  } catch {
    throw new Error(
      "AgentCursor content script is not present on this tab (chrome:// and Web Store pages are not supported)."
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
