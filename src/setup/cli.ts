import { spawn } from "node:child_process";
import { SELF } from "../server/create";
import { ensureDaemon } from "../server/proxy";
import { clients, launchEntry } from "./clients";

export async function setup(port: number, argv: string[]): Promise<void> {
  await ensureDaemon(port);
  const all = argv.includes("--all");
  const only = argv.find((a) => a.startsWith("--client="))?.slice("--client=".length).split(",");
  const entry = launchEntry(SELF);

  console.log("AI apps on this machine:");
  for (const c of clients()) {
    if (!c.detect()) continue;
    let state = c.configured() ? "connected" : "not connected";
    if (state === "not connected" && (all || only?.includes(c.id))) {
      try {
        state = `connected (${c.connect(entry)})`;
      } catch (e) {
        state = `failed: ${(e as Error).message}`;
      }
    }
    console.log(`  ${c.name.padEnd(15)} ${state}`);
  }

  const url = `http://127.0.0.1:${port}`;
  console.log(`\nSetup page: ${url}`);
  console.log("Connect everything at once: agentcursor setup --all");
  if (!argv.includes("--no-open")) openUrl(url);
}

function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}
