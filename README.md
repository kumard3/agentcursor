# AgentCursor

**Local, free, human-like browser automation over MCP — for agents, testing, and workflows.**

AgentCursor gives you (and any coding agent or automation script) a **real browser** driven with **visible, convincingly human cursor movement and timing**.

Use it as:
- A powerful MCP tool for Claude, Cursor, Grok, custom agents, etc.
- A realistic E2E / acceptance testing tool that works on actual production sites (human paths + timing are more resilient than robotic Playwright clicks).
- A workflow automation engine for complex multi-step processes (logins, form flows, data entry, admin tasks) with natural hover, move, type, and scroll behavior.
- A debugging / demo automation tool (the cursor is visible so you can watch exactly what the automation did).

All local. All free. MIT licensed. No cloud, no paywalled stealth.

The major browser automation MCPs often make realistic movement a cloud-only feature. AgentCursor brings the realistic cursor to your local machine for agents **and** traditional testing/automation use cases.

> Status: phase 1 (Chrome extension) and phase 2 (macOS OS-cursor for genuinely
> trusted events) are both implemented. See [`docs/DESIGN.md`](docs/DESIGN.md).

## Changelog (key updates)

- **0.2.4**: `read_page` resolves multi-ID `aria-labelledby` names (it was passing the whole space-separated list to `getElementById` as one ID, so those labels came back empty); now shadow-DOM-tree-scope aware.
- **0.2.3**: `drag` now performs a real drag (press at the start, move with the button held, release at the end) in the stealth (`chrome.debugger`) and OS-cursor drivers — previously a move-then-click. `pnpm smoke` asserts the `screenshot` image content.
- **0.2.2**: `drag` tool. `screenshot` now returns a viewport-scaled image (1 image pixel = 1 click coordinate) for a vision loop — see the page, then `click`/`move_to` by `x/y`. Stealth (`chrome.debugger`) moves also animate the visible overlay, so the cursor stays on screen. Ships as a Claude Code plugin. Internal snapshot refresh resolves refs past the 60th element. `pnpm build` no longer mutates version files (use `pnpm reload` for the extension dev loop).
- **0.2.0**: Added `screenshot`, `hover`, `status` MCP tools. Deep shadow DOM traversal in `read_page` / snapshot (critical for X.com, Reddit, modern SPAs). Library re-exports for programmatic use. Repositioned as general local automation/testing/workflow tool over MCP. Version bumps and packaging polish.
- 0.1.0: Initial MCP server, human path engine, extension bridge, OS cursor driver, basic tools (read_page, click, type, etc.).

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
git clone https://github.com/kumard3/agentcursor.git
cd agentcursor
pnpm install
pnpm build      # builds dist/index.js + extension/dist/*
```

### Install as a Claude Code plugin (one step)

AgentCursor ships as a Claude Code plugin that registers the MCP server for you:

```bash
claude plugin marketplace add kumard3/agentcursor
claude plugin install agentcursor
```

That registers the `agentcursor` MCP server automatically (no manual `claude mcp add`). You still load the extension once (step 1 below). If you previously registered it by hand, remove that to avoid two servers fighting for the port: `claude mcp remove agentcursor`.

### 1. Load the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Keep a normal `http(s)` tab open and focused (not `chrome://` or the Web
   Store — content scripts can't run there).

### 2. Connect via MCP (agents, Cursor, Claude, custom tools, etc.)

**Claude Code / Claude Desktop:**

```bash
claude mcp add agentcursor -- node /absolute/path/to/agentcursor/dist/index.js
```

**Cursor, Windsurf, or any MCP-capable coding environment:**

Add to your MCP servers config (exact format depends on the host):

```json
{
  "mcpServers": {
    "agentcursor": {
      "command": "node",
      "args": ["/absolute/path/to/agentcursor/dist/index.js"]
    }
  }
}
```

**Any other MCP client** (including future Grok harnesses, custom agents, test runners that speak MCP) — just point it at the stdio server the same way.

The server exposes the WebSocket bridge on `ws://127.0.0.1:8930` (override with `AGENTCURSOR_WS_PORT`). The extension auto-reconnects.

### 3. Programmatic / Direct "API" use (tests, scripts, your own automation)

The architecture is intentionally layered. You can use AgentCursor without going through the full MCP server:

- Import the path engine and `ActionService` + a driver for pure Node automation.
- Or run the MCP server and speak to it from any MCP client library (the smoke test shows exactly how).
- Future: optional lightweight HTTP API mode for non-MCP consumers.

See `src/action/service.ts`, `src/drivers/*`, and `src/path-engine` for the reusable pieces. The same human movement logic powers both the MCP tools and direct usage.

This makes AgentCursor a solid foundation for your internal testing frameworks or agent tool use.

## Tools (MCP)

| Tool | What it does |
| --- | --- |
| `read_page` | Interactive elements with stable `[ref]` handles, roles, rects, visible text. Call this first in almost every test or workflow. |
| `move_to` | Human-like path to a `[ref]` or `x/y` (no click). |
| `click` | Full human move + click (supports button, double, stealth mode for trusted events). |
| `hover` | Human approach + hover events (mouseover/mouseenter). Critical for dropdowns, tooltips, nav, and realistic workflows. |
| `drag` | Human path drag from ref/coords to target while holding button (sliders, reorder, canvas). |
| `type` | Human-timed keystrokes (auto human-clicks ref to focus if provided). |
| `scroll` | Eased, human-stepped scrolling. |
| `screenshot` | Capture the visible tab as an image, scaled so 1 image pixel = 1 click coordinate — see the page, then `click`/`move_to` by `x/y` (the vision loop). Also for visual assertions and agent grounding. |
| `navigate` | Load a URL in the active tab. |
| `get_url` | Current tab URL. |
| `wait_for` | Wait for element ref or visible text (up to timeout). Use for resilient testing flows. |
| `status` | Health / connection status, driver, active URL, port. Great for CI, long-running workflows, and monitoring. |

Any driving action accepts `stealth: true` to deliver trusted events through the
`chrome.debugger` driver (this shows Chrome's "debugging this browser" banner).

## Using as a Testing & Workflow Automation Tool

AgentCursor is not only for agents — it's a practical local browser automation primitive you can use directly in tests and scripts via MCP or by importing the core.

**Why it shines for testing/automation on real sites**:
- Human cursor paths + dwell + jitter + off-center clicks make interactions look like a real person (useful when sites have light behavioral signals).
- The visible cursor + overlay makes it excellent for **demo videos**, **manual review of automation**, and debugging failing flows.
- `screenshot` + `read_page` + `wait_for` + `hover` give you the primitives for visual + functional checks.
- Works against your **real Chrome profile** (cookies, extensions, logins) — perfect for realistic E2E that headless tools struggle with.

Example flow an agent or a test script might do:

```
read_page
hover "nav-menu"
click "Products"
wait_for text:"Featured"
screenshot
type {ref: "search", text: "laptop"}
click "search button"
...
```

**Direct / programmatic use (API style)**: The core `ActionService`, path engine, and drivers are designed to be importable. See "Programmatic Use" below.

### Example: Using with Claude Code to post on X.com / Reddit

With the MCP integration, you can tell Claude Code (or Cursor) to use agentcursor for realistic posting/automation on real sites:

1. Have a logged-in tab open on x.com (or reddit.com).
2. Start the server (ideally with OS driver on mac for best results).
3. In Claude: "Add agentcursor MCP if not present, then use the tools to navigate to x.com if needed, read the page, hover and click the compose area, type a test post, screenshot for verification, and click the post button. Use human-like actions and wait_for as needed. Report status often."

The shadow DOM support (added in 0.2.0) helps surface elements inside X's web components. Combine with `screenshot` + `status` + loops of `read_page` / `wait_for` for resilience on SPAs.

See the testing section above for general flow patterns. Always start with `status` and `read_page`, use `screenshot` to ground the agent.

## Trusted OS cursor (phase 2, macOS)

Content-script events are `isTrusted=false`, and `chrome.debugger` still leaks
CDP tells. For genuinely trusted, indistinguishable input, switch to the
OS-cursor driver, which moves the real macOS system cursor along the same human
path:

```bash
pnpm add @nut-tree-fork/nut-js        # optional native dependency
AGENTCURSOR_DRIVER=os node dist/index.js
```

It still reads the page through the extension (keep a normal tab focused), but
every move/click/scroll becomes a real OS event. Requires the Chrome window
visible and foregrounded at 100% zoom, and Accessibility permission for your
terminal/Node in System Settings → Privacy & Security. Coordinate mapping for
multi-monitor / fractional-scaling setups is still rough.

## Measuring realism

Serve the detector over http (the extension's content script only runs on
`http(s)`, not `file://`):

```bash
python3 -m http.server 8080 --directory test-detector
```

Open `http://localhost:8080`, click the targets by hand, then drive them with
the agent. Each click is scored on straightness, velocity variance, dwell,
off-center landing, overshoot, and `isTrusted` — the same features detectors
use. Use it to tune the engine.

## Development

```bash
pnpm dev         # run the server with tsx (no build)
pnpm typecheck    # tsc --noEmit
pnpm test             # vitest (path-engine + coord-map unit tests)
pnpm build:ext    # rebuild just the extension (no version change)
pnpm reload       # rebuild the extension AND patch-bump the version, so a chrome://extensions reload is visibly new
pnpm smoke        # end-to-end run: real MCP client + server, simulated browser (now covers screenshot/hover/status too)
```

The `smoke` script is also a good template for writing your own automation or test runners that drive AgentCursor over MCP.

## Credits

The path engine builds on the `ghost-cursor` lineage (Bézier + Fitts) and the
mouse-dynamics literature — WindMouse, SapiAgent, BeCAPTCHA-Mouse, and the
vendor write-ups from DataDome and Castle on what makes synthetic movement
detectable. See [`docs/DESIGN.md`](docs/DESIGN.md).

## License

[MIT](LICENSE)
