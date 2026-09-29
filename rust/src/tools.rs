//! Every tool, shared by the CLI and the MCP server.

use crate::cursor::Cursor;
use crate::motion::{off_center, Rng};
use crate::os;
use crate::view::{format_element, rank_by_text, read_or_diff, state_dir, AppState, Element};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub enum Reply {
    Text(String),
    Image { jpeg: Vec<u8>, note: String },
}

pub struct Param {
    pub name: &'static str,
    pub kind: &'static str,
    pub desc: &'static str,
    pub required: bool,
}

const fn opt(name: &'static str, kind: &'static str, desc: &'static str) -> Param {
    Param { name, kind, desc, required: false }
}

const fn req(name: &'static str, kind: &'static str, desc: &'static str) -> Param {
    Param { name, kind, desc, required: true }
}

pub struct Tool {
    pub name: &'static str,
    pub desc: &'static str,
    pub params: &'static [Param],
}

const APP: Param = opt("app", "string", "app name or pid; defaults to the app you last used");
const REF: Param = opt("ref", "string", "[dN] ref from read");
const TEXT: Param = opt("text", "string", "visible text or label to target");

pub const TOOLS: &[Tool] = &[
    Tool { name: "apps", desc: "List running apps; * marks the one the user is in.", params: &[] },
    Tool {
        name: "open",
        desc: "Start an app, or attach to it if running, without bringing it to the front, so the user is not interrupted. front: true switches to it.",
        params: &[req("app", "string", "app name"), opt("front", "boolean", "bring it to the front")],
    },
    Tool {
        name: "read",
        desc: "Read an app window as compact text: buttons, fields, links, menus and text, each with a [dN] ref and centre point. Far cheaper than a screenshot. find returns only the best matches for a label; changes returns only what changed since your last read.",
        params: &[APP, opt("find", "string", "label to look for"), opt("max", "number", "max elements (default 150)"), opt("changes", "boolean", "only what changed since the last read")],
    },
    Tool {
        name: "wait_for",
        desc: "Wait until text or a label shows up (a page or list still loading), then return it with its [dN] ref.",
        params: &[req("text", "string", "text or label to wait for"), APP, opt("timeoutMs", "number", "default 10000")],
    },
    Tool {
        name: "click",
        desc: "Click a [dN] ref, a label (text) or screen x/y with the agent's own cursor. Uses the app's accessibility action, so it works in the background: the user's pointer and focus stay put. right opens the context menu.",
        params: &[REF, TEXT, opt("x", "number", "screen x"), opt("y", "number", "screen y"), APP, opt("right", "boolean", "right-click"), opt("double", "boolean", "double-click")],
    },
    Tool {
        name: "type",
        desc: "Type into a field (ref, or into = its label) or the focused one. Sets the text through accessibility, so it lands in background apps. keys types keystroke by keystroke instead (native apps). clear replaces the text, submit presses Enter.",
        params: &[req("text", "string", "text to type"), REF, opt("into", "string", "label of the field"), APP, opt("clear", "boolean", "replace the current text"), opt("submit", "boolean", "press Enter after"), opt("keys", "boolean", "send real keystrokes"), opt("fast", "boolean", "set the text at once instead of typing it")],
    },
    Tool {
        name: "key",
        desc: "Press a key or shortcut in the app: enter, esc, tab, down, cmd+s. Sent in the background; Chromium browsers ignore background keys.",
        params: &[req("keys", "string", "e.g. enter, cmd+shift+t"), APP],
    },
    Tool {
        name: "scroll",
        desc: "Scroll a [dN] ref or label into view, or scroll by dy pixels (positive = down) over it.",
        params: &[REF, TEXT, opt("dy", "number", "pixels, positive = down"), opt("dx", "number", "pixels"), APP],
    },
    Tool {
        name: "screenshot",
        desc: "JPEG of the app window (or around a ref), even when it is covered. Use only when read is not enough: canvases, images, custom-drawn UI.",
        params: &[APP, REF, opt("maxWidth", "number", "default 1024")],
    },
    Tool {
        name: "permissions",
        desc: "Check Accessibility and Screen Recording permission; prompt asks macOS to show the grant dialogs.",
        params: &[opt("prompt", "boolean", "show the system prompts")],
    },
];

pub fn schema(t: &Tool) -> Value {
    let props: serde_json::Map<String, Value> =
        t.params.iter().map(|p| (p.name.to_string(), json!({ "type": p.kind, "description": p.desc }))).collect();
    let required: Vec<&str> = t.params.iter().filter(|p| p.required).map(|p| p.name).collect();
    json!({ "type": "object", "properties": props, "required": required })
}

fn s(args: &Value, k: &str) -> Option<String> {
    match &args[k] {
        Value::String(v) if !v.is_empty() => Some(v.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn n(args: &Value, k: &str) -> Option<f64> {
    match &args[k] {
        Value::Number(v) => v.as_f64(),
        Value::String(v) => v.parse().ok(),
        _ => None,
    }
}

fn b(args: &Value, k: &str) -> bool {
    matches!(&args[k], Value::Bool(true)) || matches!(&args[k], Value::String(v) if v == "true")
}

fn session() -> std::path::PathBuf {
    state_dir().join("session")
}

fn target_app(args: &Value) -> Result<os::App, String> {
    let app = match s(args, "app") {
        Some(q) => os::find_app(&q)?,
        None => {
            let pid = std::fs::read_to_string(session()).ok().and_then(|p| p.trim().parse::<i32>().ok());
            let pid = pid.ok_or("Pass app (a name or pid): no app used yet.")?;
            os::find_app(&pid.to_string()).map_err(|_| "The app you last used has quit; pass app.".to_string())?
        }
    };
    let _ = std::fs::write(session(), app.pid.to_string());
    Ok(app)
}

/// A fresh read with refs assigned, ready to act on.
fn read_app(app: &os::App, max: usize) -> Result<(os::Snapshot, AppState), String> {
    let mut snap = os::snapshot(app, max)?;
    let mut st = AppState::load(app.pid as i64);
    st.assign(&mut snap.elements);
    Ok((snap, st))
}

struct Target {
    app: os::App,
    snap: Option<os::Snapshot>,
    index: Option<usize>,
    point: (f64, f64),
    width: f64,
}

impl Target {
    fn handle(&self) -> Option<&os::Ax> {
        Some(&self.snap.as_ref()?.handles[self.index?])
    }

    fn element(&self) -> Option<&Element> {
        Some(&self.snap.as_ref()?.elements[self.index?])
    }

    fn describe(&self) -> String {
        let at = format!("({}, {})", self.point.0.round(), self.point.1.round());
        match self.element() {
            Some(e) if e.name.is_empty() => format!("[{}] {} at {at}", e.r#ref, e.role),
            Some(e) => format!("[{}] {} \"{}\" at {at}", e.r#ref, e.role, e.name),
            None => at,
        }
    }
}

fn resolve(args: &Value, label: Option<String>, cur: &Cursor) -> Result<Target, String> {
    let app = target_app(args)?;
    if let (Some(x), Some(y)) = (n(args, "x"), n(args, "y")) {
        return Ok(Target { app, snap: None, index: None, point: (x, y), width: 24.0 });
    }
    let (snap, st) = read_app(&app, 400)?;
    let found = if let Some(r) = s(args, "ref") {
        st.find(&snap.elements, &r).ok_or(format!("Unknown ref '{r}': read again."))?
    } else if let Some(q) = label {
        *rank_by_text(&snap.elements, &q)
            .first()
            .ok_or(format!("Nothing labelled \"{q}\" in {}. Try read or screenshot.", app.name))?
    } else {
        return Err("Pass ref, text, or x and y.".into());
    };
    st.save();
    let index = snap.elements.iter().position(|e| std::ptr::eq(e, found));
    let point = off_center(found.x, found.y, found.w, found.h, &mut Rng::fresh(), cur.traits.precision);
    let width = found.w.min(found.h).max(8.0);
    Ok(Target { app, snap: Some(snap), index, point, width })
}

const POSTED_NOTE: &str = " (posted event: native apps accept it in the background, Chromium does not; read again to check it landed)";

pub fn call(name: &str, args: &Value) -> Result<Reply, String> {
    let args = if args.is_object() { args.clone() } else { json!({}) };
    let text = |t: String| Ok(Reply::Text(t));
    match name {
        "apps" => text(
            os::apps()
                .iter()
                .map(|a| format!("{} {} (pid {})", if a.active { "*" } else { " " }, a.name, a.pid))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        "open" => {
            let q = s(&args, "app").ok_or("Pass app.")?;
            let app = os::open(&q, b(&args, "front"))?;
            let _ = std::fs::write(session(), app.pid.to_string());
            text(format!("{} (pid {}) is {}", app.name, app.pid, if b(&args, "front") { "in front" } else { "ready in the background" }))
        }
        "read" => {
            let app = target_app(&args)?;
            let find = s(&args, "find");
            let max = n(&args, "max").map(|m| m as usize).unwrap_or(if find.is_some() { 400 } else { 150 });
            let (snap, mut st) = read_app(&app, max)?;
            if let Some(q) = find {
                st.save();
                let hits: Vec<String> = rank_by_text(&snap.elements, &q).into_iter().take(8).map(format_element).collect();
                return text(if hits.is_empty() { format!("Nothing matching \"{q}\".") } else { hits.join("\n") });
            }
            let w = &snap.window;
            let mut lines = vec![format!(
                "{} window \"{}\" @{},{} {}x{} (element @x,y = center)",
                snap.app.name, w.title, w.x, w.y, w.w, w.h
            )];
            lines.extend(snap.elements.iter().map(format_element));
            if snap.truncated {
                lines.push("(more elements hidden; pass a larger max)".into());
            }
            let body = if b(&args, "changes") { read_or_diff(st.last.as_deref(), &lines) } else { lines.join("\n") };
            st.last = Some(lines);
            st.save();
            text(body)
        }
        "wait_for" => {
            let q = s(&args, "text").ok_or("Pass text.")?;
            let app = target_app(&args)?;
            let timeout = n(&args, "timeoutMs").unwrap_or(10_000.0);
            let deadline = Instant::now() + Duration::from_millis(timeout as u64);
            loop {
                if let Ok((snap, st)) = read_app(&app, 400) {
                    st.save();
                    if let Some(hit) = rank_by_text(&snap.elements, &q).first() {
                        return text(format_element(hit));
                    }
                }
                if Instant::now() >= deadline {
                    return text(format!("\"{q}\" did not appear within {timeout}ms."));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        "click" => {
            let mut cur = Cursor::connect();
            let t = resolve(&args, s(&args, "text"), &cur)?;
            cur.glide(t.point, t.width);
            let pid = t.app.pid;
            let (right, double) = (b(&args, "right"), b(&args, "double"));
            let how = match t.handle() {
                Some(h) if right && os::show_menu(h) => "opened the menu of".to_string(),
                Some(h) if !right && !double && os::press(h) => "pressed".to_string(),
                _ => {
                    os::post_click(pid, t.point.0, t.point.1, right, double, 70);
                    format!("clicked{POSTED_NOTE}")
                }
            };
            text(format!("{how} {}", t.describe()))
        }
        "type" => {
            let value = s(&args, "text").ok_or("Pass text.")?;
            let mut cur = Cursor::connect();
            let target = if s(&args, "ref").is_some() || s(&args, "into").is_some() {
                let t = resolve(&args, s(&args, "into"), &cur)?;
                cur.glide(t.point, t.width);
                Some(t)
            } else {
                None
            };
            let app = match &target {
                Some(t) => t.app.clone(),
                None => target_app(&args)?,
            };
            let field = target.as_ref().and_then(|t| t.handle().cloned()).or_else(|| os::focused_element(app.pid));
            let clear = b(&args, "clear");
            // ponytail: past 200 chars typing takes >15 s, so long text is set at once
            let human = !b(&args, "fast") && value.chars().count() <= 200;
            let how = match &field {
                Some(f) if !b(&args, "keys") && os::set_text(f, &value, clear, human) => if human { "typed" } else { "set" },
                _ => {
                    if let Some(f) = &field {
                        os::press(f);
                    }
                    if clear {
                        os::post_combo(app.pid, "cmd+a")?;
                        os::post_combo(app.pid, "backspace")?;
                    }
                    os::post_text(app.pid, &value, 45);
                    "typed"
                }
            };
            let mut out = format!("{how} {} chars", value.chars().count());
            if b(&args, "submit") {
                if !field.as_ref().is_some_and(os::confirm) {
                    os::post_combo(app.pid, "enter")?;
                }
                out.push_str(" and submitted");
            }
            if let Some(t) = &target {
                out.push_str(&format!(" into {}", t.describe()));
            }
            text(out)
        }
        "key" => {
            let keys = s(&args, "keys").ok_or("Pass keys.")?;
            let app = target_app(&args)?;
            os::post_combo(app.pid, &keys)?;
            text(format!("pressed {keys} in {}", app.name))
        }
        "scroll" => {
            let mut cur = Cursor::connect();
            let dy = n(&args, "dy");
            if s(&args, "ref").is_none() && s(&args, "text").is_none() {
                let app = target_app(&args)?;
                let (snap, _) = read_app(&app, 1)?;
                let w = &snap.window;
                let mid = (w.x + w.w / 2.0, w.y + w.h / 2.0);
                cur.glide(mid, 200.0);
                os::post_move(app.pid, mid.0, mid.1);
                os::post_scroll(app.pid, n(&args, "dx").unwrap_or(0.0), dy.unwrap_or(0.0), 6);
                return text(format!("scrolled dy={}{POSTED_NOTE}", dy.unwrap_or(0.0)));
            }
            let t = resolve(&args, s(&args, "text"), &cur)?;
            cur.glide(t.point, t.width);
            match (dy, t.handle()) {
                (None, Some(h)) => {
                    os::scroll_into_view(h);
                    text(format!("scrolled {} into view", t.describe()))
                }
                _ => {
                    os::post_move(t.app.pid, t.point.0, t.point.1);
                    os::post_scroll(t.app.pid, n(&args, "dx").unwrap_or(0.0), dy.unwrap_or(0.0), 6);
                    text(format!("scrolled dy={} over {}{POSTED_NOTE}", dy.unwrap_or(0.0), t.describe()))
                }
            }
        }
        "screenshot" => {
            let app = target_app(&args)?;
            let with_ref = s(&args, "ref");
            let (snap, st) = read_app(&app, if with_ref.is_some() { 400 } else { 1 })?;
            let region = match with_ref {
                Some(r) => {
                    let e = st.find(&snap.elements, &r).ok_or(format!("Unknown ref '{r}': read again."))?;
                    Some((e.x - 40.0, e.y - 40.0, e.w + 80.0, e.h + 80.0))
                }
                None => None,
            };
            let (jpeg, note) = os::screenshot(&snap, region, n(&args, "maxWidth").unwrap_or(1024.0) as u32)?;
            Ok(Reply::Image { jpeg, note })
        }
        "permissions" => {
            let (ax, screen) = os::permissions(b(&args, "prompt"));
            text(format!("accessibility: {ax}\nscreen_recording: {screen}"))
        }
        _ => Err(format!("Unknown tool '{name}'. Run `agentcursor tools`.")),
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn schemas_list_required_params() {
        let t = TOOLS.iter().find(|t| t.name == "type").unwrap();
        let s = schema(t);
        assert_eq!(s["required"], json!(["text"]));
        assert_eq!(s["properties"]["clear"]["type"], "boolean");
    }
}
