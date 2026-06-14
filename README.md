# Ghosthand

**Human-like cursor browser automation for coding agents, over MCP.**

Ghosthand lets any MCP-capable coding agent (Claude Code, Cursor, …) read the
page you're looking at and drive it with a **visible, human-like cursor** — one
that's convincing both to a person watching the screen and to behavioral bot
detection.

The major agent browser servers (Playwright MCP, browser-use, Stagehand,
Skyvern) don't ship human-like cursor movement in their open-source core —
stealth is paywalled into cloud tiers. Ghosthand is that missing piece, MIT
licensed.

> Status: phase 1 (Chrome extension). Phase 2 (macOS OS-cursor for genuinely
> trusted events) is on the roadmap. See [`docs/DESIGN.md`](docs/DESIGN.md).

## How it works

Three layers, with one shared wire contract (`src/protocol`):

```
coding agent ──MCP/stdio──▶ MCP server ──localhost WebSocket──▶ Chrome extension ──▶ your real tab
                            (src/server)                        (extension/)
                                 │
                                 ▼
                          human-path engine (src/path-engine)
            from + to → timed cursor samples with overshoot, log-normal
            velocity, jitter, off-center landing, dwell — fresh every call
```

The MCP server generates the cursor sample stream; the extension is a thin
replayer. The same stream works for the content-script driver, the
`chrome.debugger` stealth driver, and (phase 2) the OS cursor — they all
implement one `BrowserDriver` interface.

## Why human-like movement is hard

Modern detectors (DataDome, Castle, reCAPTCHA v3, PerimeterX) flag overly smooth
Bézier paths, constant velocity, dead-center clicks, zero dwell, teleporting
jumps, and replayed identical paths. The engine addresses each:

- **Fitts's law** sets per-move duration from distance and target size.
- **Asymmetric, eased velocity** — not a symmetric min-jerk bell.
- **Overshoot-and-correct** on long moves.
- **Sub-pixel Gaussian jitter**, zero at the endpoints.
- **Off-center landing** inside the target.
- **Right-skewed dwell** before the press.
- **Per-call entropy** — paths are never cached or replayed.

Realism is necessary but not sufficient: content-script events are
`isTrusted=false`, and `chrome.debugger` still leaks CDP tells. The real evasion
endgame is the phase-2 OS cursor (genuine, trusted OS events).

## Install

```bash
git clone <your-fork-url> ghosthand
cd ghosthand
npm install
npm run build      # builds dist/index.js + extension/dist/*
```

### 1. Load the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Keep a normal `http(s)` tab open and focused (not `chrome://` or the Web
   Store — content scripts can't run there).

### 2. Connect your agent

**Claude Code:**

```bash
claude mcp add ghosthand -- node /absolute/path/to/ghosthand/dist/index.js
```

**Any MCP client (JSON config):**

```json
{
  "mcpServers": {
    "ghosthand": {
      "command": "node",
      "args": ["/absolute/path/to/ghosthand/dist/index.js"]
    }
  }
}
```

The server hosts the extension WebSocket on `ws://127.0.0.1:8787` (override with
`GHOSTHAND_WS_PORT`). The extension reconnects automatically.

## Tools

| Tool | What it does |
| --- | --- |
| `read_page` | Interactive elements with `[ref]` handles, roles, rects + visible text. |
| `move_to` | Human path to a `ref` or `x/y`. No click. |
| `click` | Human move + click. `button`, `double`, `stealth`. |
| `type` | Type with human key timing; human-clicks a `ref` to focus first. |
| `scroll` | Eased scroll by `dy`/`dx`. |
| `navigate` | Point the active tab at a URL. |
| `get_url` | Current tab URL. |
| `wait_for` | Wait for a `ref` or visible `text`. |

Any driving action accepts `stealth: true` to deliver trusted events through the
`chrome.debugger` driver (this shows Chrome's "debugging this browser" banner).

## Measuring realism

Open `test-detector/index.html` and click the targets by hand, then drive them
with the agent. Each click is scored on straightness, velocity variance, dwell,
off-center landing, overshoot, and `isTrusted` — the same features detectors
use. Use it to tune the engine.

## Development

```bash
npm run dev         # run the server with tsx (no build)
npm run typecheck    # tsc --noEmit
npm test             # vitest (path-engine unit tests)
npm run build:ext    # rebuild just the extension
```

## Credits

The path engine builds on the `ghost-cursor` lineage (Bézier + Fitts) and the
mouse-dynamics literature — WindMouse, SapiAgent, BeCAPTCHA-Mouse, and the
vendor write-ups from DataDome and Castle on what makes synthetic movement
detectable. See [`docs/DESIGN.md`](docs/DESIGN.md).

## License

[MIT](LICENSE)
