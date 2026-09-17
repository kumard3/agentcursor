import { createRuntime, resolvePorts } from "./server/create";
import { serve } from "./server/http";
import { runStdioProxy } from "./server/proxy";
import { setup } from "./setup/cli";

const [command = "mcp", ...rest] = process.argv.slice(2);
const ports = resolvePorts();

if (command === "serve") {
  await serve(createRuntime(ports), { idleExitMs: rest.includes("--idle-exit") ? 10 * 60_000 : undefined });
} else if (command === "setup") {
  await setup(ports.http, rest);
  process.exit(0);
} else if (command === "mcp") {
  await runStdioProxy(ports.http);
} else {
  process.stderr.write(
    "usage: agentcursor [mcp|serve|setup]\n  mcp    stdio MCP server for AI apps (default)\n  serve  run the local service in the foreground\n  setup  connect your AI apps and open the setup page (--all, --client=cursor,codex, --no-open)\n",
  );
  process.exit(1);
}
