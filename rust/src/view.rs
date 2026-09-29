//! What an agent reads: compact element lines with stable [dN] refs, text
//! ranking, and diff reads. Refs persist in a small per-app state file, so
//! separate CLI calls and the MCP server agree on them without a daemon.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone, Debug, Default)]
pub struct Element {
    pub r#ref: String,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub disabled: bool,
    pub focused: bool,
}

impl Element {
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    /// Identity across reads. The value is left out so typing does not rename a field.
    fn key(&self) -> String {
        format!("{}|{}|{},{}", self.role, self.name, (self.x / 8.0).round(), (self.y / 8.0).round())
    }
}

pub fn format_element(e: &Element) -> String {
    let name = if e.name.is_empty() { String::new() } else { format!(" \"{}\"", e.name) };
    let value = match &e.value {
        Some(v) if !v.is_empty() => {
            let short: String = v.chars().take(60).collect();
            format!(" value=\"{}{}\"", short, if v.chars().count() > 60 { "…" } else { "" })
        }
        _ => String::new(),
    };
    let (cx, cy) = e.center();
    format!(
        "[{}] {}{}{} @{},{}{}{}",
        e.r#ref,
        e.role,
        name,
        value,
        cx.round(),
        cy.round(),
        if e.disabled { " disabled" } else { "" },
        if e.focused { " focused" } else { "" }
    )
}

/// Best matches first: exact name, prefix, substring, then value substring.
pub fn rank_by_text<'a>(elements: &'a [Element], query: &str) -> Vec<&'a Element> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let mut scored: Vec<(u8, &Element)> = elements
        .iter()
        .filter_map(|e| {
            let name = e.name.to_lowercase();
            let score = if name == q {
                100
            } else if name.starts_with(&q) {
                80
            } else if name.contains(&q) {
                60
            } else if e.value.as_deref().unwrap_or("").to_lowercase().contains(&q) {
                40
            } else {
                return None;
            };
            Some((score, e))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().map(|(_, e)| e).collect()
}

/// Line diff of two reads; elements that only moved are counted, not listed.
pub fn diff_read(prev: &[String], next: &[String]) -> String {
    let strip = |l: &str| -> String {
        match l.rfind(" @") {
            Some(i) => {
                let rest = &l[i + 2..];
                let end = rest.find(' ').unwrap_or(rest.len());
                format!("{}{}", &l[..i], &rest[end..])
            }
            None => l.to_string(),
        }
    };
    let mut pending: HashMap<String, Vec<&String>> = HashMap::new();
    for l in prev {
        pending.entry(strip(l)).or_default().push(l);
    }
    let (mut added, mut moved, mut same) = (vec![], 0, 0);
    for l in next {
        match pending.get_mut(&strip(l)).and_then(|v| if v.is_empty() { None } else { Some(v.remove(0)) }) {
            None => added.push(l),
            Some(m) if m == l => same += 1,
            Some(_) => moved += 1,
        }
    }
    let removed: Vec<&String> = pending.into_values().flatten().collect();
    if added.is_empty() && removed.is_empty() && moved == 0 {
        return "no change since the last read".into();
    }
    let mut out: Vec<String> = removed.iter().map(|l| format!("- {l}")).collect();
    out.extend(added.iter().map(|l| format!("+ {l}")));
    let moved_s = if moved > 0 { format!("{moved} moved, ") } else { String::new() };
    out.push(format!("({moved_s}{same} unchanged, {} total)", next.len()));
    out.join("\n")
}

pub fn read_or_diff(prev: Option<&[String]>, next: &[String]) -> String {
    let full = next.join("\n");
    match prev {
        Some(p) => {
            let d = diff_read(p, next);
            if d.len() < full.len() { d } else { full }
        }
        None => full,
    }
}

/// Refs and the last read for one app process.
pub struct AppState {
    path: PathBuf,
    counter: u64,
    refs: HashMap<String, String>,
    info: HashMap<String, (String, String, f64, f64)>,
    pub last: Option<Vec<String>>,
}

pub fn state_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("agentcursor");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

impl AppState {
    pub fn load(pid: i64) -> Self {
        let path = state_dir().join(format!("app-{pid}.json"));
        let v: Value = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        let refs = v["refs"]
            .as_object()
            .map(|o| o.iter().filter_map(|(k, r)| Some((k.clone(), r.as_str()?.to_string()))).collect())
            .unwrap_or_default();
        let info = v["info"]
            .as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(r, i)| {
                        Some((r.clone(), (i[0].as_str()?.into(), i[1].as_str()?.into(), i[2].as_f64()?, i[3].as_f64()?)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let last = v["last"].as_array().map(|a| a.iter().filter_map(|l| l.as_str().map(String::from)).collect());
        AppState { path, counter: v["n"].as_u64().unwrap_or(0), refs, info, last }
    }

    pub fn save(&self) {
        let info: serde_json::Map<String, Value> =
            self.info.iter().map(|(r, (role, name, x, y))| (r.clone(), json!([role, name, x, y]))).collect();
        let v = json!({ "n": self.counter, "refs": self.refs, "info": info, "last": self.last });
        let _ = std::fs::write(&self.path, v.to_string());
    }

    /// Give each element its ref; the same control keeps the same ref across reads.
    pub fn assign(&mut self, elements: &mut [Element]) {
        for e in elements.iter_mut() {
            let key = e.key();
            let r = match self.refs.get(&key) {
                Some(r) => r.clone(),
                None => {
                    self.counter += 1;
                    let r = format!("d{}", self.counter);
                    self.refs.insert(key, r.clone());
                    r
                }
            };
            let (cx, cy) = e.center();
            self.info.insert(r.clone(), (e.role.clone(), e.name.clone(), cx, cy));
            e.r#ref = r;
        }
    }

    /// The element a ref named, even if it moved since that read.
    pub fn find<'a>(&self, elements: &'a [Element], r: &str) -> Option<&'a Element> {
        if let Some(e) = elements.iter().find(|e| e.r#ref == r) {
            return Some(e);
        }
        let (role, name, x, y) = self.info.get(r)?;
        elements
            .iter()
            .filter(|e| &e.role == role && &e.name == name)
            .min_by(|a, b| {
                crate::motion::dist(a.center(), (*x, *y)).total_cmp(&crate::motion::dist(b.center(), (*x, *y)))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(role: &str, name: &str, x: f64, y: f64) -> Element {
        Element { role: role.into(), name: name.into(), x, y, w: 40.0, h: 20.0, ..Default::default() }
    }

    fn state(tag: &str) -> AppState {
        let path = std::env::temp_dir().join(format!("agentcursor-test-{tag}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        AppState { path, counter: 0, refs: HashMap::new(), info: HashMap::new(), last: None }
    }

    #[test]
    fn refs_survive_insertion_and_moves() {
        let mut s = state("refs");
        let mut first = vec![el("button", "Save", 10.0, 10.0), el("textfield", "Name", 10.0, 40.0)];
        s.assign(&mut first);
        let mut second = vec![el("text", "New", 10.0, 0.0), el("button", "Save", 10.0, 10.0), el("textfield", "Name", 10.0, 40.0)];
        s.assign(&mut second);
        assert_eq!(second[1].r#ref, first[0].r#ref);
        assert_eq!(second[2].r#ref, first[1].r#ref);
        let moved = vec![el("button", "Save", 300.0, 300.0)];
        assert_eq!(s.find(&moved, &first[0].r#ref).unwrap().x, 300.0);
    }

    #[test]
    fn state_round_trips() {
        let mut s = state("io");
        let mut v = vec![el("button", "Go", 1.0, 2.0)];
        s.assign(&mut v);
        s.last = Some(vec!["a".into()]);
        s.save();
        let raw = std::fs::read_to_string(&s.path).unwrap();
        let back: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(back["n"], 1);
        assert_eq!(back["last"][0], "a");
        let _ = std::fs::remove_file(&s.path);
    }

    #[test]
    fn diff_lists_changes_and_counts_moves() {
        let prev = vec!["[d1] button \"A\" @10,10".to_string(), "[d2] text \"B\" @10,40".to_string()];
        let next = vec!["[d1] button \"A\" @10,90".to_string(), "[d3] text \"C\" @10,40".to_string()];
        let d = diff_read(&prev, &next);
        assert!(d.contains("- [d2] text \"B\" @10,40"));
        assert!(d.contains("+ [d3] text \"C\" @10,40"));
        assert!(d.contains("1 moved"));
        assert_eq!(diff_read(&prev, &prev), "no change since the last read");
    }

    #[test]
    fn ranking_prefers_exact_then_prefix() {
        let v = vec![el("text", "Save draft now", 0.0, 0.0), el("button", "Save", 0.0, 0.0), el("text", "Autosave", 0.0, 0.0)];
        let r = rank_by_text(&v, "save");
        assert_eq!(r[0].name, "Save");
        assert_eq!(r[1].name, "Save draft now");
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn line_format_matches_the_typescript_one() {
        let mut e = el("textfield", "Email", 0.0, 0.0);
        e.r#ref = "d4".into();
        e.value = Some("kumar@x.dev".into());
        e.focused = true;
        assert_eq!(format_element(&e), "[d4] textfield \"Email\" value=\"kumar@x.dev\" @20,10 focused");
    }
}
