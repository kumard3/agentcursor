import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clients, connectClient, writeJsonEntry } from "../src/setup/clients";
import { isAllowedRequest } from "../src/server/guard";
import { parseKeyCombo } from "../src/drivers/nut";
import { formatView } from "../src/desktop/service";

const entry = { command: "/usr/local/bin/node", args: ["/opt/agentcursor/dist/index.js"] };

describe("isAllowedRequest", () => {
  it("accepts local MCP clients without an Origin", () => {
    expect(isAllowedRequest("127.0.0.1:8931", undefined, 8931)).toBe(true);
    expect(isAllowedRequest("localhost:8931", undefined, 8931)).toBe(true);
  });
  it("accepts the setup page's own origin", () => {
    expect(isAllowedRequest("127.0.0.1:8931", "http://127.0.0.1:8931", 8931)).toBe(true);
  });
  it("rejects other websites and DNS rebinding hosts", () => {
    expect(isAllowedRequest("127.0.0.1:8931", "https://evil.example", 8931)).toBe(false);
    expect(isAllowedRequest("evil.example:8931", undefined, 8931)).toBe(false);
    expect(isAllowedRequest(undefined, undefined, 8931)).toBe(false);
    expect(isAllowedRequest("127.0.0.1:9999", undefined, 8931)).toBe(false);
  });
});

describe("parseKeyCombo", () => {
  it("maps shortcuts to nut key names", () => {
    expect(parseKeyCombo("cmd+shift+s")).toEqual(["LeftCmd", "LeftShift", "S"]);
    expect(parseKeyCombo("Enter")).toEqual(["Enter"]);
    expect(parseKeyCombo("ctrl+1")).toEqual(["LeftControl", "Num1"]);
    expect(parseKeyCombo("f12")).toEqual(["F12"]);
    expect(parseKeyCombo("esc")).toEqual(["Escape"]);
  });
  it("rejects unknown keys", () => {
    expect(() => parseKeyCombo("cmd+banana")).toThrow(/Unknown key/);
  });
});

describe("writeJsonEntry", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "agentcursor-test-"));

  it("adds the server and keeps existing ones, with a backup", () => {
    const path = join(dir(), "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    writeJsonEntry(path, "mcpServers", entry);
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.agentcursor).toEqual(entry);
    expect(config.theme).toBe("dark");
    expect(existsSync(`${path}.bak`)).toBe(true);
  });

  it("creates the file and folders when missing", () => {
    const path = join(dir(), "nested", "mcp_config.json");
    writeJsonEntry(path, "mcpServers", entry);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.agentcursor).toEqual(entry);
  });

  it("refuses to rewrite JSON with comments", () => {
    const path = join(dir(), "mcp.json");
    const original = '{\n  // my servers\n  "servers": {}\n}';
    writeFileSync(path, original);
    expect(() => writeJsonEntry(path, "servers", entry)).toThrow(/Add this by hand/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});

describe("JSON clients", () => {
  it("detects, connects and reports each file-based app in its own format", () => {
    const home = mkdtempSync(join(tmpdir(), "agentcursor-home-"));
    const support = process.platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
    for (const d of [join(home, ".cursor"), join(home, ".codeium", "windsurf"), join(support, "Code", "User"), join(support, "Claude")]) {
      mkdirSync(d, { recursive: true });
    }
    for (const id of ["cursor", "windsurf", "vscode", "claude-desktop"]) {
      const client = clients(home).find((c) => c.id === id)!;
      expect(client.detect()).toBe(true);
      expect(client.configured()).toBe(false);
      connectClient(id, entry, home);
      expect(client.configured()).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(support, "Code", "User", "mcp.json"), "utf8")).servers.agentcursor).toEqual({ type: "stdio", ...entry });
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.agentcursor).toEqual(entry);
  });
});

describe("formatView", () => {
  it("renders compact lines with refs, values and flags", () => {
    const out = formatView({
      app: { name: "Notes", pid: 42, bundleId: "com.apple.Notes" },
      window: { title: "Notes", x: 0, y: 25, w: 800, h: 600 },
      truncated: true,
      elements: [
        { ref: "d1", role: "button", name: "New Note", rect: { x: 10, y: 40, width: 30, height: 22 } },
        { ref: "d2", role: "textfield", name: "Search", value: "milk", rect: { x: 500, y: 40, width: 180, height: 22 }, focused: true },
        { ref: "d3", role: "button", name: "Delete", rect: { x: 60, y: 40, width: 30, height: 22 }, enabled: false },
      ],
    });
    expect(out).toBe(
      [
        'Notes window "Notes" @0,25 800x600 (element @x,y = center)',
        '[d1] button "New Note" @25,51',
        '[d2] textfield "Search" value="milk" @590,51 focused',
        '[d3] button "Delete" @75,51 disabled',
        "(more elements hidden; pass a larger max)",
      ].join("\n"),
    );
  });
});
