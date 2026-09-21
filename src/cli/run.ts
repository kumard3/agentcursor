import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClient, ensureDaemon } from "../server/proxy";

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { type?: string; enum?: string[]; description?: string }> };
}

type Args = Record<string, string | number | boolean>;

/**
 * Agent-facing CLI: one shell command per MCP tool, run against the shared
 * local service, so [refs], the page and the app stay put between calls and no
 * tool schemas are ever loaded into the model's context.
 */
export async function runTool(port: number, argv: string[]): Promise<number> {
  const name = argv[0]?.replace(/-/g, "_");
  await ensureDaemon(port);
  const client = await connectClient(port);
  const tools = ((await client.listTools()).tools ?? []) as unknown as ToolInfo[];

  if (!name || name === "help" || name === "tools" || name === "--help" || name === "-h") {
    process.stdout.write(usage(tools, name === "tools"));
    return 0;
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    process.stderr.write(`agentcursor: unknown command '${argv[0]}'. Try: agentcursor help\n`);
    return 1;
  }
  const args = parseArgs(tool, argv.slice(1));
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60_000 })) as {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
  for (const part of result.content ?? []) {
    if (part.type === "text") process.stdout.write(`${part.text}\n`);
    else if (part.type === "image" && part.data) process.stdout.write(`${await saveImage(part.data, part.mimeType)}\n`);
  }
  return result.isError ? 1 : 0;
}

/** Images go to a file, so an agent decides whether to spend tokens looking at them. */
async function saveImage(data: string, mimeType = "image/png"): Promise<string> {
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  const file = join(process.env.AGENTCURSOR_OUT ?? tmpdir(), `agentcursor-${Date.now()}.${ext}`);
  await writeFile(file, Buffer.from(data, "base64"));
  return file;
}

export function parseArgs(tool: ToolInfo, rest: string[]): Args {
  const props = tool.inputSchema.properties ?? {};
  const order = Object.keys(props);
  const args: Args = {};
  let next = 0;
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i]!;
    if (item.startsWith("--")) {
      const [flag, inline] = splitFlag(item.slice(2));
      const type = props[flag]?.type;
      if (type === "boolean" && inline === undefined) {
        const peek = rest[i + 1];
        const explicit = peek === "true" || peek === "false";
        args[flag] = explicit ? peek === "true" : true;
        if (explicit) i++;
      } else args[flag] = coerce(inline ?? rest[++i] ?? "", type);
      continue;
    }
    // Positionals fill the tool's parameters in order: `click e12`, `type e5 hello`.
    while (next < order.length && order[next]! in args) next++;
    const key = order[next++];
    if (!key) throw new Error(`agentcursor: too many arguments for ${tool.name}`);
    args[key] = coerce(item, props[key]?.type);
  }
  return args;
}

function splitFlag(s: string): [string, string | undefined] {
  const eq = s.indexOf("=");
  return eq === -1 ? [s, undefined] : [s.slice(0, eq), s.slice(eq + 1)];
}

function coerce(value: string, type?: string): string | number | boolean {
  if (type === "number" || type === "integer") {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`agentcursor: '${value}' is not a number`);
    return n;
  }
  if (type === "boolean") return value !== "false" && value !== "0";
  return value;
}

function usage(tools: ToolInfo[], full: boolean): string {
  const lines = [
    "agentcursor: a visible human cursor for browser tabs and Mac apps.",
    "",
    "  agentcursor <command> [positional...] [--flag value]",
    "",
    "Positionals fill a command's parameters in the order listed below.",
    "State (page, [refs], frontmost app) is kept by one background service, so commands chain.",
    "",
    "Browser (needs the Chrome extension):",
  ];
  const line = (t: ToolInfo) => {
    const params = Object.entries(t.inputSchema.properties ?? {})
      .map(([k, v]) => (v.enum ? `${k}=${v.enum.join("|")}` : k))
      .join(" ");
    const desc = full ? `\n      ${t.description ?? ""}` : "";
    return `  ${t.name.padEnd(19)} ${params}${desc}`;
  };
  for (const t of tools.filter((t) => !t.name.startsWith("desktop_"))) lines.push(line(t));
  const desktop = tools.filter((t) => t.name.startsWith("desktop_"));
  if (desktop.length) {
    lines.push("", "Any Mac app (computer use; read is text, not pixels):");
    for (const t of desktop) lines.push(line(t));
  }
  lines.push(
    "",
    "Also: agentcursor setup | serve | mcp (stdio MCP server) | tools (same list with full descriptions)",
    "Screenshots are written to a file and the path is printed. AGENTCURSOR_OUT sets the directory.",
    "",
  );
  return lines.join("\n");
}
