mod cursor;
mod mcp;
mod motion;
mod tools;
mod view;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as os;
#[cfg(not(target_os = "macos"))]
compile_error!("agentcursor runs on macOS today; Windows and Linux are next.");

use serde_json::{Map, Value};

const HELP: &str = "agentcursor: computer use with the agent's own cursor.

  agentcursor <tool> [args]   run one tool, e.g. agentcursor read Safari
  agentcursor tools           list tools and their arguments
  agentcursor mcp             run as an MCP server over stdio

Arguments fill in order, or use --name value / --name=value / --flag.
Refs from one call ([d12]) keep working in the next.";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("help" | "-h" | "--help") => println!("{HELP}"),
        Some("--version" | "-V") => println!("agentcursor {}", env!("CARGO_PKG_VERSION")),
        Some("mcp") => mcp::serve(),
        Some("cursor-daemon") => cursor::daemon(),
        Some("tools") => {
            for t in tools::TOOLS {
                let params: Vec<String> =
                    t.params.iter().map(|p| if p.required { p.name.to_string() } else { format!("[{}]", p.name) }).collect();
                println!("{:<12} {}", t.name, params.join(" "));
            }
        }
        Some(name) => std::process::exit(run(name, &args[1..])),
    }
}

fn run(name: &str, rest: &[String]) -> i32 {
    let Some(tool) = tools::TOOLS.iter().find(|t| t.name == name) else {
        eprintln!("Unknown tool '{name}'. Run `agentcursor tools`.");
        return 2;
    };
    let args = match parse(tool, rest) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    match tools::call(name, &args) {
        Ok(tools::Reply::Text(t)) => {
            println!("{t}");
            0
        }
        Ok(tools::Reply::Image { jpeg, note }) => {
            let dir = std::env::var("AGENTCURSOR_OUT").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
            let file = dir.join(format!("agentcursor-{}.jpg", std::process::id()));
            match std::fs::write(&file, jpeg) {
                Ok(()) => {
                    println!("{}\n{note}", file.display());
                    0
                }
                Err(e) => {
                    eprintln!("{e}");
                    1
                }
            }
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// Positionals fill parameters in order; --name value, --name=value and bare --flag also work.
fn parse(tool: &tools::Tool, rest: &[String]) -> Result<Value, String> {
    let mut out = Map::new();
    let mut positional = tool.params.iter();
    let mut i = 0;
    while i < rest.len() {
        let arg = &rest[i];
        let (key, raw) = if let Some(flag) = arg.strip_prefix("--") {
            match flag.split_once('=') {
                Some((k, v)) => (k.to_string(), Some(v.to_string())),
                None => (flag.to_string(), None),
            }
        } else {
            let p = positional.next().ok_or(format!("Too many arguments for {}.", tool.name))?;
            (p.name.to_string(), Some(arg.clone()))
        };
        let key = if tool.params.iter().any(|p| p.name == key) { key } else { camel(&key) };
        let param = tool.params.iter().find(|p| p.name == key).ok_or(format!("{} has no --{key}.", tool.name))?;
        let raw = match raw {
            Some(v) => Some(v),
            None if param.kind == "boolean" => None,
            None => {
                i += 1;
                Some(rest.get(i).ok_or(format!("--{key} needs a value."))?.clone())
            }
        };
        let value = match (param.kind, raw) {
            ("boolean", None) => Value::Bool(true),
            ("boolean", Some(v)) => Value::Bool(v != "false"),
            ("number", Some(v)) => v.parse::<f64>().map(Value::from).map_err(|_| format!("--{key} must be a number."))?,
            (_, Some(v)) => Value::String(v),
            (_, None) => unreachable!(),
        };
        out.insert(key, value);
        i += 1;
    }
    Ok(Value::Object(out))
}

/// --timeout-ms and --max-width map to timeoutMs and maxWidth.
fn camel(key: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for ch in key.chars() {
        if ch == '-' || ch == '_' {
            up = true;
        } else if up {
            out.extend(ch.to_uppercase());
            up = false;
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(name: &str) -> &'static tools::Tool {
        tools::TOOLS.iter().find(|t| t.name == name).unwrap()
    }

    #[test]
    fn cli_args_fill_the_schema() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse(tool("read"), &a(&["Safari", "--changes"])).unwrap(), json!({ "app": "Safari", "changes": true }));
        assert_eq!(
            parse(tool("wait_for"), &a(&["Beta Labs", "--timeout-ms", "1500"])).unwrap(),
            json!({ "text": "Beta Labs", "timeoutMs": 1500.0 })
        );
        assert_eq!(parse(tool("type"), &a(&["hi", "--into=Search", "--submit"])).unwrap(), json!({ "text": "hi", "into": "Search", "submit": true }));
        assert!(parse(tool("read"), &a(&["--nope"])).is_err());
    }
}
