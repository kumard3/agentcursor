import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_WS_PORT,
  PROTOCOL_VERSION,
  type Command,
  type CommandEnvelope,
  type CommandResult,
} from "../protocol";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const NOT_CONNECTED =
  "AgentCursor extension is not connected. Load the extension and open a normal browser tab.";

/** Hosts a localhost WebSocket and turns commands into awaited request/reply. */
export class ExtensionTransport {
  private readonly wss: WebSocketServer;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(port = DEFAULT_WS_PORT) {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.wss.on("connection", (ws) => {
      this.socket = ws;
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("close", () => {
        if (this.socket === ws) this.socket = null;
      });
      ws.on("error", () => undefined);
    });
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(command: Command, timeoutMs = 30_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(NOT_CONNECTED));
    }
    const id = randomUUID();
    const envelope: CommandEnvelope = { v: PROTOCOL_VERSION, id, command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${command.kind}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(envelope));
    });
  }

  private onMessage(raw: string): void {
    let result: CommandResult;
    try {
      result = JSON.parse(raw) as CommandResult;
    } catch {
      return;
    }
    const entry = this.pending.get(result.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(result.id);
    if (result.ok) entry.resolve(result.data);
    else entry.reject(new Error(result.error));
  }

  close(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.wss.close();
  }
}
