//! MCP over stdio: newline-delimited JSON-RPC.
// ponytail: handshake-era protocol only (initialize). Clients that also speak
// 2026-07-28 probe server/discover, get "Method not found" and fall back
// (spec SEP-2575). Switch to the rmcp crate if a modern-only client appears.

use crate::tools::{self, Reply};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub fn serve() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue };
        let reply = match handle(msg["method"].as_str().unwrap_or(""), &msg["params"]) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
            return;
        }
    }
}

fn handle(method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = if VERSIONS.contains(&asked) { asked } else { VERSIONS[0] };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "agentcursor", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Computer use with the agent's own cursor. read an app first (text with [dN] refs), then click/type by ref or label. Actions go through accessibility, so they work while the user keeps using their Mac. open starts apps in the background.",
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": tools::TOOLS.iter().map(|t| json!({
                "name": t.name, "description": t.desc, "inputSchema": tools::schema(t),
            })).collect::<Vec<_>>()
        })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            Ok(match tools::call(name, &params["arguments"]) {
                Ok(Reply::Text(t)) => json!({ "content": [{ "type": "text", "text": t }] }),
                Ok(Reply::Image { jpeg, note }) => json!({ "content": [
                    { "type": "image", "data": tools::base64(&jpeg), "mimeType": "image/jpeg" },
                    { "type": "text", "text": note },
                ] }),
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            })
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}
