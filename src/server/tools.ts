import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActionService } from "../action/service";
import type { PageElement, PageSnapshot } from "../protocol";

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

export function registerTools(server: McpServer, action: ActionService): void {
  server.registerTool(
    "read_page",
    {
      description:
        "Read the current page: interactive elements with stable [ref] handles, their roles/names and on-screen rectangles, plus visible text. Call before clicking or typing by ref.",
      inputSchema: {
        maxElements: z.number().int().min(1).max(200).optional(),
        includeText: z.boolean().optional(),
      },
    },
    async ({ maxElements, includeText }) => {
      const snap = await action.readPage(maxElements ?? 60, includeText ?? true);
      return text(formatSnapshot(snap));
    },
  );

  server.registerTool(
    "find",
    {
      description:
        "Identification: locate on-screen elements by their visible text or accessible name (shadow-DOM aware), the way a human scans a page. Returns ranked matches with [ref], role, and on-screen rect. Use when you don't already have a ref, then click/move_to/hover by [ref] — or use click_text to do it in one step.",
      inputSchema: {
        text: z.string(),
        maxResults: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ text: query, maxResults }) => {
      const matches = await action.find(query, { maxResults });
      if (!matches.length) return text(`No elements matching "${query}".`);
      return text(matches.map(formatElement).join("\n"));
    },
  );

  server.registerTool(
    "click_text",
    {
      description:
        "Identification + interaction in one step: find the element that best matches the given text/label, then human-move the cursor to it and click. Re-reads the page if the element isn't there yet. `nth` picks a later match, `stealth:true` delivers trusted events, `double` double-clicks.",
      inputSchema: {
        text: z.string(),
        nth: z.number().int().min(0).optional(),
        double: z.boolean().optional(),
        stealth: z.boolean().optional(),
      },
    },
    async ({ text: query, nth, double, stealth }) => {
      const { matched, point } = await action.clickText(query, { nth, double, stealth });
      return text(
        `clicked "${matched.name || matched.ref}" [${matched.ref}] at (${point.x.toFixed(0)}, ${point.y.toFixed(0)})`,
      );
    },
  );

  server.registerTool(
    "move_to",
    {
      description:
        "Move the cursor to an element ([ref] from read_page) or to absolute viewport x/y along a human-like path. Does not click. stealth:true delivers trusted events via the debugger driver.",
      inputSchema: {
        ref: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        stealth: z.boolean().optional(),
      },
    },
    async (args) => {
      const p = await action.moveTo(args);
      return text(`moved to (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
    },
  );

  server.registerTool(
    "click",
    {
      description:
        "Human-like move + click on an element ([ref]) or x/y. Supports button, double-click, and stealth (trusted-event) mode.",
      inputSchema: {
        ref: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional(),
        stealth: z.boolean().optional(),
      },
    },
    async (args) => {
      const p = await action.click(args);
      const where = args.ref
        ? `'${args.ref}'`
        : `(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`;
      return text(`clicked ${where}`);
    },
  );

  server.registerTool(
    "type",
    {
      description:
        "Type text with human key timing. If a ref is given, the input is human-clicked to focus first. stealth:true uses the debugger driver.",
      inputSchema: {
        text: z.string(),
        ref: z.string().optional(),
        stealth: z.boolean().optional(),
      },
    },
    async (args) => {
      await action.type(args);
      return text(`typed ${args.text.length} chars`);
    },
  );

  server.registerTool(
    "press_key",
    {
      description:
        "Press a single key on the focused element: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character. Use to submit (Enter), dismiss dialogs (Escape), or tab between fields. stealth:true delivers a trusted key event via the debugger driver.",
      inputSchema: {
        key: z.string(),
        stealth: z.boolean().optional(),
      },
    },
    async ({ key, stealth }) => {
      await action.pressKey(key, stealth);
      return text(`pressed ${key}`);
    },
  );

  server.registerTool(
    "scroll",
    {
      description: "Scroll the page by dy (and optional dx) pixels in eased human steps.",
      inputSchema: {
        dy: z.number(),
        dx: z.number().optional(),
        stealth: z.boolean().optional(),
      },
    },
    async (args) => {
      await action.scroll(args);
      return text(`scrolled dy=${args.dy}`);
    },
  );

  server.registerTool(
    "navigate",
    {
      description: "Navigate the active tab to a URL.",
      inputSchema: { url: z.string() },
    },
    async ({ url }) => {
      await action.navigate(url);
      return text(`navigating to ${url}`);
    },
  );

  server.registerTool(
    "get_url",
    { description: "Return the active tab's current URL.", inputSchema: {} },
    async () => text(await action.getUrl()),
  );

  server.registerTool(
    "wait_for",
    {
      description:
        "Wait until an element [ref] appears or some visible text is present (or specific condition), up to timeoutMs (default 10000). Supports condition: 'exists' | 'visible' | 'text'. Use in testing and automation flows for resilience on dynamic sites.",
      inputSchema: {
        ref: z.string().optional(),
        text: z.string().optional(),
        timeoutMs: z.number().int().optional(),
        condition: z.enum(["exists", "visible", "text"]).optional(),
      },
    },
    async (args) => {
      const ok = await action.waitFor(args);
      return text(ok ? "found" : "timed out");
    },
  );

  server.registerTool(
    "screenshot",
    {
      description:
        "Capture the visible tab as an image, scaled so 1 image pixel = 1 click coordinate. SEE the page, then click(x,y)/move_to(x,y) at coordinates read off the image. This is the vision loop (screenshot -> decide coords -> click -> screenshot) and needs no DOM refs.",
      inputSchema: {
        format: z.enum(["png", "jpeg"]).optional(),
      },
    },
    async ({ format }) => {
      const dataUrl = await action.screenshot(format ?? "png");
      const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) return text(dataUrl);
      return { content: [{ type: "image" as const, data: m[2]!, mimeType: m[1]! }] };
    },
  );

  server.registerTool(
    "hover",
    {
      description:
        "Human-like move the cursor to an element or coordinates and fire hover events (mouseover, mouseenter). Essential for dropdowns, tooltips, navigation menus, and realistic workflow/testing automation.",
      inputSchema: {
        ref: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        stealth: z.boolean().optional(),
      },
    },
    async (args) => {
      await action.hover(args);
      const where = args.ref ? `'${args.ref}'` : args.x != null ? `(${args.x},${args.y})` : "current position";
      return text(`hovered ${where}`);
    },
  );

  server.registerTool(
    "status",
    {
      description:
        "Return current MCP server status, driver in use (extension or os), whether the browser bridge is connected, and the active tab URL if available. Use for health checks in long-running tests, CI workflows, and agent monitoring.",
      inputSchema: {},
    },
    async () => {
      const url = await action.getUrl().catch(() => null);
      const connected = url !== null;
      return text(
        [
          `driver: ${process.env.AGENTCURSOR_DRIVER ?? "extension"}`,
          `bridge_connected: ${connected}`,
          `active_url: ${url ?? "none (extension not connected or no http tab)"}`,
          `ws_port: ${process.env.AGENTCURSOR_WS_PORT ?? 8930}`,
          "protocol_version: 1",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "drag",
    {
      description:
        "Perform a human-like drag from one element/ref or coords to another (e.g. for sliders, reordering, canvas drawing). Uses the realistic path engine while holding the mouse button.",
      inputSchema: {
        fromRef: z.string().optional(),
        fromX: z.number().optional(),
        fromY: z.number().optional(),
        toRef: z.string().optional(),
        toX: z.number().optional(),
        toY: z.number().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        stealth: z.boolean().optional(),
      },
    },
    async (args) => {
      await action.drag(
        { ref: args.fromRef, x: args.fromX, y: args.fromY },
        { ref: args.toRef, x: args.toX, y: args.toY },
        (args.button ?? "left") as any,
        args.stealth,
      );
      return text("dragged");
    },
  );

  // MCP Prompt for better agent guidance (Phase 3 adoption)
  server.registerPrompt(
    "human-browser-task",
    {
      description: "Guide for performing realistic, human-like browser automation tasks using agentcursor tools. Use this for any non-trivial interaction on real websites.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `When using agentcursor:
1. Always call status and read_page first to understand the current page and connection.
2. Use [ref] from read_page for all clicks, hovers, types.
3. For complex pages, use screenshot often to ground yourself.
4. Prefer human-like: move_to or hover before click, use wait_for for dynamic content.
5. On modern sites (X, Reddit etc), the snapshot now handles shadow DOM.
6. For stealth on sensitive sites, use stealth:true (but it shows debugger banner).
7. After navigate or major changes, re-read_page.
8. Use ensureVisible implicitly via the tools (scrolls targets into view).
Be patient with SPAs - combine wait_for + read_page loops.`,
          },
        },
      ],
    }),
  );
}

function formatSnapshot(snap: PageSnapshot): string {
  const lines: string[] = [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    `Viewport: ${snap.viewport.width}x${snap.viewport.height} (scroll ${snap.viewport.scrollX},${snap.viewport.scrollY}, dpr ${snap.viewport.devicePixelRatio})`,
    `Elements (${snap.elements.length}):`,
  ];
  for (const e of snap.elements) {
    const r = e.rect;
    const name = e.name ? ` "${truncate(e.name, 60)}"` : "";
    const val = e.value ? ` value="${truncate(e.value, 40)}"` : "";
    const vis = e.visible !== undefined ? (e.visible ? " visible" : " hidden") : "";
    const vp = e.inViewport !== undefined ? (e.inViewport ? " in-view" : " off-view") : "";
    lines.push(
      `  [${e.ref}] ${e.role}${name} <${e.tag}>${val} @ ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}${vis}${vp}`,
    );
  }
  if (snap.text) lines.push("", "Text:", truncate(snap.text, 4000));
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatElement(e: PageElement): string {
  const r = e.rect;
  const name = e.name ? ` "${truncate(e.name, 60)}"` : "";
  const vp = e.inViewport === false ? " off-view" : "";
  return `  [${e.ref}] ${e.role}${name} <${e.tag}> @ ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}${vp}`;
}
