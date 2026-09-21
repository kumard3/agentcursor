import { launchBrowser } from "../sdk/launch";
import type { Ports } from "../server/create";
import { ensureDaemon } from "../server/proxy";

interface LaunchFlags {
  userDataDir?: string;
  executablePath?: string;
  headless: boolean;
  port?: number;
}

function parseFlags(rest: string[]): LaunchFlags {
  const flags: LaunchFlags = { headless: false };
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i]!;
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const name = raw.slice(2, eq === -1 ? undefined : eq);
    if (name === "headless") {
      flags.headless = true;
      continue;
    }
    if (!["user-data-dir", "profile", "chrome", "executable-path", "port"].includes(name)) {
      throw new Error(`unknown flag --${name}`);
    }
    const value = eq === -1 ? rest[++i] : raw.slice(eq + 1);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (name === "user-data-dir" || name === "profile") flags.userDataDir = value;
    else if (name === "chrome" || name === "executable-path") flags.executablePath = value;
    else flags.port = Number(value);
  }
  return flags;
}

/**
 * Start a browser wired to the running MCP service so an agent drives it with
 * the normal tools. `--user-data-dir` uses a real, logged-in profile (no copy,
 * left intact); `--headless` runs it in the background. Holds until Ctrl-C.
 */
export async function launchCli(ports: Ports, rest: string[]): Promise<void> {
  let flags: LaunchFlags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    process.stderr.write(`agentcursor launch: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const wsPort = flags.port ?? ports.ws;
  await ensureDaemon(ports.http);
  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    browser = await launchBrowser(wsPort, {
      headless: flags.headless,
      userDataDir: flags.userDataDir,
      executablePath: flags.executablePath,
    });
  } catch (err) {
    process.stderr.write(`agentcursor launch: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const where = flags.userDataDir ? `profile ${flags.userDataDir}` : "a throwaway profile";
  process.stderr.write(
    `agentcursor: browser up on ${where}${flags.headless ? " (headless)" : ""}, ` +
      `wired to ws://127.0.0.1:${wsPort}. Drive it from your agent ` +
      `(agentcursor read_page / click / evaluate ...). Ctrl-C to stop.\n`,
  );
  const stop = async () => {
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<never>(() => {});
}
