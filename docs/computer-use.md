# Computer use (Rust core)

`rust/` is a single binary, `agentcursor` 0.5.0, that reads and drives any macOS app window with the agent's own cursor. It has no Node dependency. For web pages see [extension.md](extension.md).

## Build and install

```bash
cd rust && cargo build --release
```

Output: `rust/target/release/agentcursor` (609 KB, arm64). To keep the build off a full disk: `CARGO_TARGET_DIR=/other/disk/target cargo build --release`. There is no brew formula, curl installer or npm package. Copy the binary where you want it.

Grant Accessibility (and Screen Recording, only for screenshots) to the app that launches it. `agentcursor permissions --prompt` asks macOS to show the dialogs.

## MCP config

```json
{
  "mcpServers": {
    "agentcursor": {
      "command": "/absolute/path/to/agentcursor",
      "args": ["mcp"]
    }
  }
}
```

The Claude Code plugin's `.mcp.json` still runs the Node server (`dist/index.js`), not this binary. Register the Rust binary yourself if you want it, for example `claude mcp add --scope user agentcursor-rust -- /abs/path/agentcursor mcp`.

## CLI

```bash
agentcursor <tool> [args]
agentcursor tools
agentcursor mcp
```

Arguments fill in order, or use `--name value`, `--name=value` or `--flag`. Refs from one call (`[d12]`) keep working in the next.

```bash
agentcursor apps
agentcursor open Notes
agentcursor read Notes
agentcursor click --text Delete --app Notes
agentcursor type "hello" --into Title --app Notes --submit
```

## Tools

| Tool | Arguments |
| --- | --- |
| `apps` | none. Running apps; `*` marks the user's app. |
| `open` | `app` `[front]`. Starts or attaches without bringing it forward unless `front`. |
| `read` | `[app] [find] [max] [changes]`. Window as compact text with `[dN]` refs. `find` returns best matches; `changes` returns only what changed. |
| `wait_for` | `text [app] [timeoutMs]` |
| `click` | `[ref] [text] [x] [y] [app] [right] [double]` |
| `type` | `text [ref] [into] [app] [clear] [submit] [keys] [fast]`. `keys` types keystroke by keystroke (native apps). |
| `key` | `keys [app]`, such as `enter`, `esc`, `cmd+s`. |
| `scroll` | `[ref] [text] [dy] [dx] [app]` |
| `screenshot` | `[app] [ref] [maxWidth]`. JPEG, works on covered windows. Only for canvases and custom UI. |
| `permissions` | `[prompt]` |

## Background behaviour

Click uses the AXPress accessibility action and type sets AXValue, so the target app does not need focus. `open` does not raise the app. Verified live on Chrome, Safari and TextEdit in the background: the user's front app stayed in front and the pointer did not move. A visible agent cursor is drawn by a small per-user helper process (`cursor-daemon`); `AGENTCURSOR_CURSOR=0` disables it.

## Rust vs the Node `desktop_*` tools

| | Rust core | Node `desktop_*` |
| --- | --- | --- |
| Input | accessibility actions, background | real cursor and keyboard, mostly foreground |
| Helper | none | Swift helper |
| Install | cargo build | pnpm build |
| Wired into the other | no | no |

Measured 2026-09-30 on one Mac, same window, identical output, Rust vs Node: read 278 to 71 ms, find 221 to 55 ms, apps 166 to 14 ms. Peak memory 9.9 MB per call vs 126 MB (CLI) plus 218 MB (service).

Node background input through `CGEventPostToPid` works for native AppKit apps only; Chromium and Electron ignore it.

## Limits

- macOS only, arm64 only. Other targets fail to compile.
- Hover-only widgets do not work.
- Chromium ignores background keys (Enter, arrows). Use `type --submit` or click.
- Empty `type` text is rejected.
- Apps that draw their own UI without accessibility need `screenshot` plus `x`/`y`.
