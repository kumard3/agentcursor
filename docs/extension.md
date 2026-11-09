# Browser extension

Drives Chrome tabs from an MCP client or the SDK. The Node server (`src/`) generates a human-like cursor path and the MV3 extension (`extension/`) replays it in the tab and reads the page. For native apps see [computer-use.md](computer-use.md).

## Install and load

```bash
pnpm install
pnpm build
node dist/index.js setup
```

Load the extension once: open `chrome://extensions`, enable Developer mode, Load unpacked, select the `extension/` folder. Keep a normal `http(s)` tab open. Content scripts do not run on `chrome://` pages or the Web Store.

After rebuilding the extension (`pnpm build` or `pnpm build:ext`), reload it at `chrome://extensions`.

## Connect an agent

`node dist/index.js setup` lists detected AI apps and connects them. By hand:

```bash
claude mcp add --scope user agentcursor -- node /absolute/path/to/agentcursor/dist/index.js
```

Any MCP client can run `node dist/index.js` over stdio, or use `http://127.0.0.1:8931/mcp` while the service runs (`node dist/index.js serve`). `AGENTCURSOR_TOOLS=browser` registers only the browser tools.

## Tools

`read_page`, `find`, `click_text`, `move_to`, `click`, `hover`, `drag`, `type`, `press_key`, `scroll`, `screenshot`, `navigate`, `get_url`, `tabs`, `evaluate`, `wait_for`, `status`. Start with `read_page`, which returns elements with stable `[ref]` handles. Then act by ref or visible text (`click_text`), then read again.

## Content vs stealth mode

- Content mode (default): events come from the content script and are `isTrusted=false`. Works without a banner.
- Stealth mode: pass `stealth: true`. Events go through `chrome.debugger` and are trusted. Chrome shows its "debugging this browser" banner. Use it for React-controlled inputs and detection-sensitive sites.
- `evaluate` also uses the debugger and shows the banner while it runs.
- An OS-cursor driver (`AGENTCURSOR_DRIVER=os`) moves the real macOS cursor for fully trusted input. See the README.

## Tabs

`tabs` lists tabs, `select` picks one to drive without switching to it (by id or URL/title text), `new` opens a URL in a background tab, `close` closes one. A background tab supports reads, clicks and typing, not `screenshot`.

## Ports

- `8930`: WebSocket bridge to the extension. Override with `AGENTCURSOR_WS_PORT`.
- `8931`: HTTP MCP and the setup page. Override with `AGENTCURSOR_HTTP_PORT`.

Every AI app launches `agentcursor` over stdio; they share one background service that exits after 10 minutes idle. A rebuild replaces an older running service on the next launch.

## Stuck server recovery

```bash
lsof -nP -iTCP:8930 -sTCP:LISTEN
kill <pid>
```

Then reconnect the MCP client. The extension reconnects by itself. `curl -X POST http://127.0.0.1:8931/shutdown` also stops the service.

## SDK

```ts
import { AgentCursor } from "agentcursor";
```

`AgentCursor.launch()` starts a private Chrome with its own extension copy for tests. `ac.record({ path: "run.mp4" })` records the tab through a CDP screencast and encodes with ffmpeg at the real paint timing; without ffmpeg it keeps the frames and sets `note`. This is a repo-local import; the package is not on npm.
