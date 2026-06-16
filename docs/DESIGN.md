# AgentCursor — Design

Local, free, human-like browser automation over MCP.

Positioned for coding agents, E2E testing, QA workflows, and general browser automation on real sites. The human cursor + timing is the key differentiator that makes interactions resilient and observable.

## Goal

Let any MCP-capable coding agent (Claude Code, Cursor, …) read the page you're
looking at and drive it with a **visible, human-like cursor** that is convincing
both to a person watching the screen and to behavioral bot detection.

Inspiration: the "AI disguised as a Google Doc" extensions — except here the
disguise is *the automation itself looking human*, and the consumer is a coding
agent, not a person hiding a chatbot.

## Why human-like cursor movement is non-trivial

Modern bot detection (DataDome, Castle, reCAPTCHA v3, PerimeterX) does not just
check for straight lines. They flag:

- overly smooth Bézier paths and constant velocity (zero acceleration),
- clicking the exact element center,
- zero dwell / no hesitation before click,
- no movement before a click, teleporting jumps (no intermediate `mousemove`),
- low entropy / replayed identical paths,
- environment leaks (`isTrusted=false`, `navigator.webdriver`, the CDP
  coordinate-alignment bug, the `Runtime.enable` leak).

So realism is **necessary but not sufficient**: a perfect path over a leaky
transport still scores as a bot. That shapes the phasing below.

## Architecture — three layers

| Layer | Responsibility | Notes |
| --- | --- | --- |
| **MCP server** (`src/server`, `src/action`) | Exposes tools to the agent. Owns a local WebSocket the extension connects to. | `@modelcontextprotocol/sdk`, stdio transport. |
| **Human-path engine** (`src/path-engine`) | The brain. `from + to → timed cursor samples` with overshoot, log-normal velocity, jitter, off-center landing, dwell. **Substrate-agnostic, identical across phases.** | Pure, deterministic-with-seed, unit-tested. |
| **Driver** (`src/drivers`) | Delivers samples to a real browser. Phase 1: Chrome extension over WS. Phase 2: macOS OS-cursor. | `BrowserDriver` interface → dependency inversion. |

Single source of truth for the wire contract + shared types lives in
`src/protocol` (DRY). Both the Node server and the extension import it.

### Data flow (click on a ref)

```
agent → click(ref) → ActionService
  ActionService.resolveTarget(ref) → off-center point inside element rect
  ActionService asks driver for cursor start position (cached lastPos)
  path-engine.generateMove(from, to) → CursorSample[]  (fresh entropy each call)
  driver.replayClick(samples, target, dwell)  → extension replays + dispatches
  ActionService.lastPos = target
```

The server generates the sample stream; the extension is a thin replayer. This
keeps a single engine (testable in Node) and works identically for the
content-script and `chrome.debugger` delivery modes, and later for the OS cursor.

## MCP tool surface (phase 1)

`read_page`, `move_to`, `click`, `type`, `scroll`, `navigate`, `get_url`,
`wait_for`. Any action accepting `stealth: true` is delivered via
`chrome.debugger` (`isTrusted=true`); otherwise via content-script
`PointerEvent`s.

## The path engine

Built on the `ghost-cursor` lineage (Bézier + Fitts's law) and extended per the
research:

- **Fitts's law** sets duration: `T = a + b · log2(distance/width + 1)`, with
  `a, b` sampled per call.
- **Asymmetric velocity** via an eased, slightly-skewed parameterization (not a
  symmetric min-jerk bell).
- **Overshoot-and-correct** for long moves: shoot past, short corrective return.
- **Sub-pixel jitter** (Gaussian), scaled to zero at the endpoints.
- **Off-center landing** inside the target rect.
- **Right-skewed dwell** before press and a short press duration.
- **Per-call entropy**: paths are never cached or replayed; an optional seed
  exists only for tests.

## Phasing

- **Phase 1 — Hybrid Chrome extension (MV3) [implemented]:** MCP plumbing,
  `read_page`, visible animated cursor, content-script default with a
  `chrome.debugger` stealth path. Ships fast, runs on your real Chrome, no
  separate install.
- **Phase 2 — macOS OS-cursor driver [implemented]:** the same engine feeds
  `@nut-tree-fork/nut-js` (optional native dep) to move the *real* system cursor
  → genuinely trusted, indistinguishable events. Selected with
  `AGENTCURSOR_DRIVER=os`. Implements the same `BrowserDriver` interface; senses
  the page through the extension (`snapshot`, `windowGeometry`) and maps element
  rects → screen coordinates via `src/drivers/coord-map`. Multi-monitor and
  fractional-scaling mapping is still approximate.

## Testing / validation

- `test/` — unit tests for the path engine: non-straight paths, varying
  velocity, monotonic timestamps, off-center landing, overshoot, per-call
  entropy, seed determinism, Fitts duration scaling.
- `test-detector/` — a local page that logs mouse telemetry and scores
  straightness ratio, velocity variance, entropy, dwell, and click offset, so
  realism is *measured*, not assumed.

## Known risks

- MV3 service-worker WebSocket termination (mitigated via `chrome.alarms` +
  active-WS keepalive on Chrome 116+).
- `chrome.debugger` shows the yellow banner, can't touch `chrome://`, and
  retains CDP tells — stealth mode is "better," not "perfect"; phase 2 is the
  real evasion.
- Content-script `isTrusted=false` limits which sites honor synthetic events.
- Phase 2 screen-coordinate mapping across DPI / multi-monitor is fiddly.
