//! The agent's own cursor: one small process per user, drawn above every
//! window and click-through. CLI calls and the MCP server stream positions to
//! it over a Unix socket, so it stays where the agent left it between calls.

use crate::motion::{generate_move, Rng, Traits};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

fn sock() -> PathBuf {
    crate::view::state_dir().join("cursor.sock")
}

fn enabled() -> bool {
    std::env::var("AGENTCURSOR_CURSOR").map_or(true, |v| v != "0")
}

/// What the cursor process is told: move there, or sit just above this window.
pub enum Msg {
    Move(f64, f64),
    Attach(i64),
}

pub struct Cursor {
    stream: Option<UnixStream>,
    pub pos: (f64, f64),
    pub traits: Traits,
}

impl Cursor {
    /// Connects to the cursor process, starting it when needed.
    pub fn connect() -> Cursor {
        let seed = std::env::var("AGENTCURSOR_SEED").ok().and_then(|s| s.parse().ok());
        let mut c = Cursor { stream: None, pos: (0.0, 0.0), traits: Traits::from_seed(seed.unwrap_or(0)) };
        if !enabled() {
            return c;
        }
        let mut stream = UnixStream::connect(sock()).ok();
        if stream.is_none() {
            if let Ok(exe) = std::env::current_exe() {
                let _ = std::process::Command::new(exe)
                    .arg("cursor-daemon")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
            let deadline = Instant::now() + Duration::from_millis(2500);
            while stream.is_none() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
                stream = UnixStream::connect(sock()).ok();
            }
        }
        if let Some(s) = stream {
            // The process greets with "x y seed": where its cursor is and whose hand it is.
            let mut line = String::new();
            let _ = s.set_read_timeout(Some(Duration::from_secs(1)));
            if BufReader::new(&s).read_line(&mut line).is_ok() {
                let v: Vec<f64> = line.split_whitespace().filter_map(|p| p.parse().ok()).collect();
                if v.len() == 3 {
                    c.pos = (v[0], v[1]);
                    if seed.is_none() {
                        c.traits = Traits::from_seed(v[2] as u32);
                    }
                }
            }
            c.stream = Some(s);
        }
        c
    }

    /// Keep the cursor just above the window it works in, so it hides behind the user's windows.
    pub fn attach(&mut self, window: Option<u32>) {
        if let (Some(id), Some(s)) = (window, self.stream.as_mut()) {
            let _ = writeln!(s, "w {id}");
        }
    }

    /// Glides to `to` along a human path at human speed; returns once it arrives.
    pub fn glide(&mut self, to: (f64, f64), target_width: f64) {
        let Some(stream) = self.stream.as_mut() else {
            self.pos = to;
            return;
        };
        let path = generate_move(self.pos, to, target_width, &self.traits, &mut Rng::fresh());
        let start = Instant::now();
        for s in path {
            let due = Duration::from_micros((s.t * 1000.0) as u64);
            if let Some(wait) = due.checked_sub(start.elapsed()) {
                std::thread::sleep(wait);
            }
            if writeln!(stream, "{:.1} {:.1}", s.x, s.y).is_err() {
                self.stream = None;
                break;
            }
        }
        self.pos = to;
    }
}

/// `agentcursor cursor-daemon`: owns the overlay window until the agent goes quiet.
pub fn daemon() {
    let path = sock();
    if UnixStream::connect(&path).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else { return };
    let pos_file = crate::view::state_dir().join("cursor-pos");
    let start: Vec<f64> = std::fs::read_to_string(&pos_file)
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|p| p.parse().ok())
        .collect();
    let pos = Arc::new(Mutex::new(if start.len() == 2 { (start[0], start[1]) } else { (400.0, 300.0) }));
    let seed = Rng::fresh().next().to_bits() as u32;
    let (tx, rx) = mpsc::channel::<Msg>();
    let shared = pos.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let (tx, pos) = (tx.clone(), shared.clone());
            std::thread::spawn(move || {
                let (x, y) = *pos.lock().unwrap();
                let mut w = &conn;
                let _ = writeln!(w, "{x} {y} {seed}");
                for line in BufReader::new(&conn).lines().map_while(Result::ok) {
                    if let Some(id) = line.strip_prefix("w ").and_then(|v| v.trim().parse().ok()) {
                        let _ = tx.send(Msg::Attach(id));
                        continue;
                    }
                    let v: Vec<f64> = line.split_whitespace().filter_map(|p| p.parse().ok()).collect();
                    if v.len() == 2 {
                        *pos.lock().unwrap() = (v[0], v[1]);
                        let _ = tx.send(Msg::Move(v[0], v[1]));
                    }
                }
            });
        }
    });
    let color = std::env::var("AGENTCURSOR_CURSOR_COLOR").ok();
    let idle = Duration::from_secs(std::env::var("AGENTCURSOR_CURSOR_IDLE").ok().and_then(|s| s.parse().ok()).unwrap_or(60));
    crate::os::run_overlay(rx, color.as_deref(), idle);
    let (x, y) = *pos.lock().unwrap();
    let _ = std::fs::write(pos_file, format!("{x} {y}"));
    let _ = std::fs::remove_file(path);
}
