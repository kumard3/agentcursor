import { runTool } from "./cli/run";
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
  process.exit(await runTool(ports.http, [command, ...rest]));
}
