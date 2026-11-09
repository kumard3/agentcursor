# AgentCursor: guide for coding agents

AgentCursor gives an AI agent a visible, human-paced cursor. It has two surfaces, and they are separate code paths.

| Surface | What it drives | Code | Needs |
| --- | --- | --- | --- |
| Browser extension | Chrome tabs (real profile, logged in) | `src/` (Node MCP server) + `extension/` (MV3) | Node, pnpm, Chrome, the extension loaded |
| Computer use (Rust core) | Any macOS app window | `rust/` (one binary, `agentcursor`) | Rust toolchain, macOS arm64, Accessibility permission |

Details: [docs/extension.md](docs/extension.md) and [docs/computer-use.md](docs/computer-use.md).

## Which one to pick

- Task is inside a web page (read DOM, click, type, tabs, JS evaluate): browser extension. Tools: `read_page`, `click`, `type`, `tabs`, `evaluate`.
- Task is a native app (Notes, Finder, Safari chrome, TextEdit, System Settings): computer use.
- Computer use must not disturb the user (front app and pointer stay put): the Rust core. It clicks and types through accessibility actions.
- Rust core is not wired under the Node `desktop_*` tools. The Node server has its own `desktop_*` implementation (Swift helper) that moves the real cursor.
- The Claude Code plugin (`.mcp.json`) still launches the Node server, not the Rust binary.

## Install and connect

Browser extension and Node server:

```bash
pnpm install && pnpm build
node dist/index.js setup
```

Then load `extension/` at `chrome://extensions` (Developer mode, Load unpacked). By hand: `claude mcp add --scope user agentcursor -- node /abs/path/dist/index.js`.

Rust core (not published to npm, brew or curl; build from source):

```bash
cd rust && cargo build --release
```

MCP config: `{"mcpServers":{"agentcursor":{"command":"/abs/path/rust/target/release/agentcursor","args":["mcp"]}}}`

There is no npm package named `agentcursor`. Never run `npm install agentcursor` or `npx agentcursor`.

## The loop

1. Read: `read_page` (browser) or `agentcursor read <app>` (computer use). Output is compact text with refs (`[12]`, `[d12]`).
2. Act by label or ref: `click --text Save` or `click [d12]`. Do not guess coordinates.
3. Verify by reading again. Use `changes` (`read --changes`) to get only the diff. Take a screenshot only for canvases and custom-drawn UI.

Refs from one call keep working in the next.

## Build and test

```bash
pnpm typecheck && pnpm test && pnpm build
cd rust && cargo build --release
```

- After rebuilding the extension, reload it at `chrome://extensions`.
- `pnpm build` writes tracked output in `dist/` and `extension/dist/`. Commit it with the source change.
- Keep build output off the internal disk if it is full: `CARGO_TARGET_DIR=/some/other/disk cargo build --release`.

## Repo map

- `src/protocol`: wire contract shared by server and extension. Change it here only.
- `src/path-engine`: pure human-motion generator, tested.
- `src/drivers`: `BrowserDriver` implementations (extension, debugger, OS cursor).
- `src/action`, `src/server`: actions and MCP tool registration.
- `src/sdk`: `AgentCursor`, `Desktop`, locators, `expect`, `record`.
- `extension/`: MV3 extension (content script, service worker, debugger driver).
- `native/`: Swift accessibility helper used by the Node `desktop_*` tools.
- `rust/src`: `main.rs` CLI, `mcp.rs` stdio server, `tools.rs` tool table, `mac.rs` accessibility, `cursor.rs` + `view.rs` + `motion.rs` visible cursor.
- `test/`, `test-detector/`: unit tests and a realism scoring page.

## Hard limits

- Computer use is macOS only. The Rust binary is arm64 only.
- Hover-only widgets do not work in the Rust core.
- Chromium browsers ignore background keys such as Enter and arrows in the Rust core. Use `type` with `submit`, or click.
- Empty `type` text is rejected.
- Node background input through `CGEventPostToPid` works for native AppKit apps only. Chromium and Electron ignore it.
- Extension content mode sends untrusted events. Pass `stealth: true` for trusted events (shows Chrome's debugging banner).
- Extension tabs: the content script does not run on `chrome://` pages or the Web Store.
- No code comments unless a one-line why. No em dashes in docs.
