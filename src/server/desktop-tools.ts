import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatElement, formatView, type DesktopService } from "../desktop/service";

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

const target = {
  ref: z.string().optional().describe("[dN] ref from desktop_read"),
  text: z.string().optional().describe("visible text or label to target"),
  x: z.number().optional(),
  y: z.number().optional(),
  app: z.string().optional(),
};

export function registerDesktopTools(server: McpServer, desktop: DesktopService): void {
  server.registerTool(
    "desktop_apps",
    { description: "List running Mac apps; * marks the frontmost one.", inputSchema: {} },
    async () => text((await desktop.apps()).map((a) => `${a.active ? "*" : " "} ${a.name} (pid ${a.pid})`).join("\n")),
  );

  server.registerTool(
    "desktop_open",
    {
      description: "Open or switch to a Mac app by name (Notes, Slack, Finder, Safari...) and bring it to the front.",
      inputSchema: { app: z.string() },
    },
    async ({ app }) => {
      const a = await desktop.open(app);
      return text(`${a.name} (pid ${a.pid}) is frontmost`);
    },
  );

  server.registerTool(
    "desktop_read",
    {
      description:
        "Read an app window as compact text: buttons, fields, links, menus and visible text, each with a [dN] ref and center point. Costs far fewer tokens than a screenshot, so call it before clicking. `find` returns only the best matches for a label. Defaults to the app you last opened or read.",
      inputSchema: {
        app: z.string().optional(),
        find: z.string().optional(),
        max: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ app, find, max }) => {
      if (find) {
        const matches = await desktop.find(find, { app });
        return text(matches.length ? matches.map(formatElement).join("\n") : `Nothing matching "${find}".`);
      }
      return text(formatView(await desktop.read({ app, max })));
    },
  );

  server.registerTool(
    "desktop_click",
    {
      description:
        "Move the real cursor along a human path and click: a [dN] ref, visible text/label, or screen x/y. Brings the app to the front first.",
      inputSchema: {
        ...target,
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional(),
      },
    },
    async (args) => text(`clicked ${await desktop.click(args)}`),
  );

  server.registerTool(
    "desktop_move",
    {
      description: "Move the real cursor to a ref, label, or x/y without clicking (menus, tooltips, hover states).",
      inputSchema: target,
    },
    async (args) => text(`moved to ${await desktop.move(args)}`),
  );

  server.registerTool(
    "desktop_type",
    {
      description:
        "Type with human timing. Clicks a field first when given ref, into (label) or x/y; otherwise types into the focused field. clear replaces the current text, submit presses Enter.",
      inputSchema: {
        text: z.string(),
        ref: z.string().optional(),
        into: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        app: z.string().optional(),
        clear: z.boolean().optional(),
        submit: z.boolean().optional(),
      },
    },
    async ({ text: value, into, ...rest }) => {
      await desktop.type({ ...rest, text: into, value });
      return text(`typed ${value.length} chars${rest.submit ? " and pressed Enter" : ""}`);
    },
  );

  server.registerTool(
    "desktop_key",
    {
      description: "Press a key or shortcut in the current app: enter, esc, tab, up, cmd+s, cmd+shift+t, ctrl+c.",
      inputSchema: { keys: z.string() },
    },
    async ({ keys }) => {
      await desktop.key(keys);
      return text(`pressed ${keys}`);
    },
  );

  server.registerTool(
    "desktop_scroll",
    {
      description:
        "Scroll by dy (positive = down) and optional dx, over a ref, label or x/y (else where the cursor is). Refs expire after scrolling; desktop_read again.",
      inputSchema: { ...target, dy: z.number(), dx: z.number().optional() },
    },
    async (args) => {
      await desktop.scroll(args);
      return text(`scrolled dy=${args.dy}${args.dx ? ` dx=${args.dx}` : ""}`);
    },
  );

  server.registerTool(
    "desktop_screenshot",
    {
      description:
        "Screenshot one app window (or the area around a ref), downscaled. Use only when desktop_read text is not enough: canvases, images, custom-drawn UI. The reply explains how to turn image pixels into screen x/y for desktop_click.",
      inputSchema: {
        app: z.string().optional(),
        ref: z.string().optional(),
        maxWidth: z.number().int().min(200).max(2000).optional(),
      },
    },
    async (args) => {
      const shot = await desktop.screenshot(args);
      return {
        content: [
          { type: "image" as const, data: shot.data, mimeType: shot.mimeType },
          { type: "text" as const, text: shot.note },
        ],
      };
    },
  );
}
