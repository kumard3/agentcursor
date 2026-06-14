import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActionService } from "../action/service";
import type { PageSnapshot } from "../protocol";

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
        "Wait until an element [ref] appears or some visible text is present, up to timeoutMs (default 10000).",
      inputSchema: {
        ref: z.string().optional(),
        text: z.string().optional(),
        timeoutMs: z.number().int().optional(),
      },
    },
    async (args) => {
      const ok = await action.waitFor(args);
      return text(ok ? "found" : "timed out");
    },
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
    lines.push(
      `  [${e.ref}] ${e.role}${name} <${e.tag}>${val} @ ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
    );
  }
  if (snap.text) lines.push("", "Text:", truncate(snap.text, 4000));
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
