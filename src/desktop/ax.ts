import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface AxApp {
  name: string;
  pid: number;
  bundleId: string;
  active?: boolean;
}

export interface AxWindow {
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AxElement {
  role: string;
  name: string;
  value?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled?: boolean;
  focused?: boolean;
}

export interface AxSnapshot extends AxApp {
  window: AxWindow;
  elements: AxElement[];
  truncated: boolean;
  visited: number;
}

export interface AxPermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export const helperPath = fileURLToPath(new URL("./native/agentcursor-ax", import.meta.url));

export const desktopSupported = (): boolean => process.platform === "darwin" && existsSync(helperPath);

export function ax<T>(args: string[], timeoutMs = 20_000): Promise<T> {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("Desktop control currently supports macOS only."));
  }
  return new Promise((resolve, reject) => {
    execFile(helperPath, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return reject(new Error(`Desktop helper missing at ${helperPath}. Run \`pnpm build\`.`));
      }
      let parsed: (T & { error?: string }) | undefined;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(err?.message ?? "Desktop helper returned no output"));
      }
      if (parsed?.error) return reject(new Error(parsed.error));
      resolve(parsed as T);
    });
  });
}

export const appArgs = (app?: string | number): string[] =>
  app === undefined ? [] : typeof app === "number" ? ["--pid", String(app)] : ["--app", app];
