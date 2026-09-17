import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export interface LaunchEntry {
  command: string;
  args: string[];
}

export interface Client {
  id: string;
  name: string;
  detect(): boolean;
  configured(): boolean;
  connect(entry: LaunchEntry): string;
}

export const SERVER_NAME = "agentcursor";

export function launchEntry(self: string): LaunchEntry {
  if (self.includes(join("_npx", ""))) {
    return { command: join(dirname(process.execPath), "npx"), args: ["-y", "agentcursor"] };
  }
  return { command: process.execPath, args: [self] };
}

const toolPath = (): string =>
  [
    process.env.PATH,
    dirname(process.execPath),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
    .filter(Boolean)
    .join(delimiter);

function which(bin: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    env: { ...process.env, PATH: toolPath() },
  });
  return r.status === 0;
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonEntry(path: string, key: string, value: object): string {
  let config: Record<string, any> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        `${path} is not plain JSON (it may contain comments). Add this by hand:\n${JSON.stringify({ [key]: { [SERVER_NAME]: value } }, null, 2)}`,
      );
    }
    copyFileSync(path, `${path}.bak`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  config[key] = { ...(config[key] ?? {}), [SERVER_NAME]: value };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return `added to ${path} (backup at .bak); restart the app to load it`;
}

function jsonClient(
  id: string,
  name: string,
  dir: string,
  file: string,
  key: string,
  shape: (e: LaunchEntry) => object = (e) => e,
): Client {
  const path = join(dir, file);
  return {
    id,
    name,
    detect: () => existsSync(dir),
    configured: () => Boolean(readJson(path)?.[key]?.[SERVER_NAME]),
    connect: (entry) => writeJsonEntry(path, key, shape(entry)),
  };
}

function cliClient(
  id: string,
  name: string,
  bin: string,
  addArgs: (e: LaunchEntry) => string[],
  configured: () => boolean,
): Client {
  return {
    id,
    name,
    detect: () => which(bin),
    configured,
    connect: (entry) => {
      const args = addArgs(entry);
      const r = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, PATH: toolPath() } });
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${bin} exited ${r.status}`).trim());
      return `added with \`${bin} ${args.slice(0, 4).join(" ")} ...\`; start a new session to load it`;
    },
  };
}

function appDataDir(home: string, ...parts: string[]): string {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", ...parts);
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), ...parts);
  return join(home, ".config", ...parts);
}

export function clients(home = homedir()): Client[] {
  return [
    cliClient(
      "claude-code",
      "Claude Code",
      "claude",
      (e) => ["mcp", "add", "--scope", "user", SERVER_NAME, "--", e.command, ...e.args],
      () => Boolean(readJson(join(home, ".claude.json"))?.mcpServers?.[SERVER_NAME]),
    ),
    jsonClient("cursor", "Cursor", join(home, ".cursor"), "mcp.json", "mcpServers"),
    jsonClient("vscode", "VS Code", appDataDir(home, "Code", "User"), "mcp.json", "servers", (e) => ({ type: "stdio", ...e })),
    cliClient(
      "codex",
      "Codex",
      "codex",
      (e) => ["mcp", "add", SERVER_NAME, "--", e.command, ...e.args],
      () => {
        try {
          return /^\[mcp_servers\.agentcursor\]/m.test(readFileSync(join(home, ".codex", "config.toml"), "utf8"));
        } catch {
          return false;
        }
      },
    ),
    jsonClient("windsurf", "Windsurf", join(home, ".codeium", "windsurf"), "mcp_config.json", "mcpServers"),
    jsonClient("claude-desktop", "Claude Desktop", appDataDir(home, "Claude"), "claude_desktop_config.json", "mcpServers"),
    cliClient(
      "gemini",
      "Gemini CLI",
      "gemini",
      (e) => ["mcp", "add", "--scope", "user", SERVER_NAME, e.command, ...e.args],
      () => Boolean(readJson(join(home, ".gemini", "settings.json"))?.mcpServers?.[SERVER_NAME]),
    ),
  ];
}

export function clientStatus(home = homedir()) {
  return clients(home).map((c) => ({ id: c.id, name: c.name, detected: c.detect(), configured: c.configured() }));
}

export function connectClient(id: string, entry: LaunchEntry, home = homedir()): string {
  const client = clients(home).find((c) => c.id === id);
  if (!client) throw new Error(`Unknown client "${id}"`);
  return client.connect(entry);
}
