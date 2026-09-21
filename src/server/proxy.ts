import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { sleep } from "../util/timing";
import { BUILD_ID, SELF, logFile, readVersion } from "./create";
import type { Health } from "./http";

const base = (port: number) => `http://127.0.0.1:${port}`;

export async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`${base(port)}/health`, { signal: AbortSignal.timeout(1_500) });
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(150);
  }
  return false;
}

export async function ensureDaemon(port: number): Promise<void> {
  const current = await health(port);
  if (current && current.buildId >= BUILD_ID) return;
  if (current) {
    await fetch(`${base(port)}/shutdown`, { method: "POST" }).catch(() => undefined);
    await until(async () => !(await health(port)), 5_000);
  }
  const log = openSync(logFile(port), "a");
  spawn(process.execPath, [SELF, "serve", "--idle-exit"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  }).unref();
  const ready = await until(async () => ((await health(port))?.buildId ?? 0) >= BUILD_ID, 15_000);
  if (!ready) throw new Error(`agentcursor could not start its local service on port ${port}. Log: ${logFile(port)}`);
}

export async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: "agentcursor-stdio", version: readVersion() });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base(port)}/mcp`)));
  return client;
}

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const slim = (t: Tool): Tool => {
  const { $schema, ...schema } = t.inputSchema as Record<string, unknown>;
  const { execution: _execution, ...rest } = t as Record<string, unknown>;
  return { ...rest, inputSchema: schema } as Tool;
};

const unreachable = (e: unknown): boolean => {
  const err = e as { message?: string; cause?: { code?: string } };
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(`${err?.message} ${err?.cause?.code}`);
};

export async function runStdioProxy(port: number): Promise<void> {
  await ensureDaemon(port);
  let client = await connectClient(port);

  const call = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    try {
      return await fn(client);
    } catch (e) {
      if (!unreachable(e)) throw e;
      await ensureDaemon(port);
      client = await connectClient(port);
      return fn(client);
    }
  };

  const server = new Server(
    { name: "agentcursor", version: readVersion() },
    { capabilities: { tools: {}, prompts: {} }, instructions: client.getInstructions() },
  );
  const long = { timeout: 15 * 60_000 };
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const res = await call((c) => c.listTools(req.params));
    return { ...res, tools: res.tools.map(slim) };
  });
  server.setRequestHandler(CallToolRequestSchema, (req) => call((c) => c.callTool(req.params, undefined, long)));
  server.setRequestHandler(ListPromptsRequestSchema, (req) => call((c) => c.listPrompts(req.params)));
  server.setRequestHandler(GetPromptRequestSchema, (req) => call((c) => c.getPrompt(req.params)));

  await server.connect(new StdioServerTransport());
  setInterval(() => void health(port), 60_000).unref();
}
