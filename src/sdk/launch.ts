import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

export interface LaunchOptions {
  /** Chrome or Chromium binary. Defaults to AGENTCURSOR_CHROME, then the usual install paths.
   * Point this at Chrome for Testing, Brave, Edge, or BrowserOS to drive that browser. */
  executablePath?: string;
  /** Run without a window (CI, or a real profile in the background). The cursor is still drawn. */
  headless?: boolean;
  /** Drive an existing profile directory instead of a throwaway copy: real cookies/logins,
   * left intact on close. The browser must NOT already be running on this dir (profile lock). */
  userDataDir?: string;
  /** Extra Chrome flags, e.g. ["--window-size=900,800", "--window-position=0,0"]. */
  args?: string[];
  /** Expose the page to the macOS accessibility tree, so computer use (Desktop) can read and
   * click it. Chrome otherwise builds that tree only for a screen reader, and a desktop read
   * sees the toolbar but no page content. */
  accessibility?: boolean;
}

export interface LaunchedBrowser {
  close(): Promise<void>;
}

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

function findChrome(explicit?: string): string {
  const path = explicit ?? process.env.AGENTCURSOR_CHROME ?? (CHROME_PATHS[process.platform] ?? []).find(existsSync);
  if (!path || !existsSync(path)) {
    throw new Error("agentcursor: Chrome not found. Pass { executablePath } or set AGENTCURSOR_CHROME.");
  }
  return path;
}

function extensionDir(): string {
  // dist/lib.js and src/sdk/launch.ts sit at different depths below the package root.
  for (const rel of ["../extension", "../../extension"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, "dist", "service-worker.js"))) return dir;
  }
  throw new Error("agentcursor: built extension not found. Run `pnpm build` first.");
}

/**
 * Starts a private Chrome (throwaway profile) with its own copy of the
 * extension wired to `port`, so it never touches the user's browser, mouse,
 * or the MCP server's extension on 8930.
 */
export async function launchBrowser(port: number, options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const chrome = findChrome(options.executablePath);
  const realProfile = options.userDataDir;
  const profile = realProfile ?? mkdtempSync(join(tmpdir(), "agentcursor-"));
  // Extension copy always lives in its own temp dir so it never litters a real profile.
  const ext = mkdtempSync(join(tmpdir(), "agentcursor-ext-"));
  const src = extensionDir();
  for (const part of ["manifest.json", "dist", "icons"]) cpSync(join(src, part), join(ext, part), { recursive: true });
  writeFileSync(join(ext, "launch.json"), JSON.stringify({ port }));

  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--password-store=basic",
    "--use-mock-keychain",
    ...(options.headless ? ["--headless=new"] : []),
    ...(options.accessibility ? ["--force-renderer-accessibility"] : []),
    ...(options.args ?? []),
    "about:blank",
  ];
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = new PipeCdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
  const exited = once(proc, "exit");

  const cleanup = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      await cdp.send("Browser.close", {}, 3_000).catch(() => proc.kill());
      await Promise.race([exited, delay(5_000).then(() => proc.kill("SIGKILL"))]);
    }
    rmSync(ext, { recursive: true, force: true, maxRetries: 5 });
    if (!realProfile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };

  try {
    await Promise.race([
      cdp.send("Extensions.loadUnpacked", { path: ext }, 15_000),
      exited.then(() => {
        throw new Error(`agentcursor: Chrome exited during launch (${chrome})`);
      }),
    ]);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { close: cleanup };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal CDP client over --remote-debugging-pipe (NUL-delimited JSON on fds 3/4). */
class PipeCdp {
  private nextId = 1;
  private buf = "";
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    input.on("error", () => undefined);
    out.on("error", () => undefined);
  }

  send(method: string, params: object, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agentcursor: CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.out.write(`${JSON.stringify({ id, method, params })}\0`);
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let end: number;
    while ((end = this.buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(this.buf.slice(0, end)) as { id?: number; result?: unknown; error?: { message: string } };
      this.buf = this.buf.slice(end + 1);
      const entry = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id!);
      if (msg.error) entry.reject(new Error(`agentcursor: CDP ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  }
}

