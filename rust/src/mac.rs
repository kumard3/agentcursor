//! macOS: read apps through the accessibility tree and act on them through
//! accessibility actions, so the user's pointer and focus are never touched.

use crate::view::Element;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation_sys::base::{CFGetTypeID, CFTypeID, CFTypeRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::number::{kCFNumberDoubleType, CFBooleanGetTypeID, CFNumberGetTypeID, CFNumberGetValue};
use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, EventField, ScrollEventUnit};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
use std::ffi::c_void;
use std::process::Command;
use std::time::{Duration, Instant};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(el: CFTypeRef, attr: CFStringRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementCopyMultipleAttributeValues(el: CFTypeRef, attrs: CFArrayRef, opts: u32, values: *mut CFArrayRef) -> i32;
    fn AXUIElementSetAttributeValue(el: CFTypeRef, attr: CFStringRef, value: CFTypeRef) -> i32;
    fn AXUIElementPerformAction(el: CFTypeRef, action: CFStringRef) -> i32;
    fn AXUIElementCopyActionNames(el: CFTypeRef, names: *mut CFArrayRef) -> i32;
    fn AXUIElementSetMessagingTimeout(el: CFTypeRef, seconds: f32) -> i32;
    fn AXUIElementGetTypeID() -> CFTypeID;
    fn AXValueGetTypeID() -> CFTypeID;
    fn AXValueGetType(v: CFTypeRef) -> u32;
    fn AXValueGetValue(v: CFTypeRef, kind: u32, out: *mut c_void) -> u8;
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(opts: CFDictionaryRef) -> u8;
    // Private but stable for a decade (yabai, Hammerspoon): the window server id of an AX window.
    fn _AXUIElementGetWindow(el: CFTypeRef, id: *mut u32) -> i32;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> u8;
    fn CGRequestScreenCaptureAccess() -> u8;
}

const AX_POINT: u32 = 1;
const AX_SIZE: u32 = 2;
const AX_ERROR: u32 = 5;

#[derive(Clone)]
pub struct Ax(CFType);

fn cfstr(s: &str) -> CFString {
    CFString::new(s)
}

fn type_of(v: CFTypeRef) -> CFTypeID {
    unsafe { CFGetTypeID(v) }
}

/// Strings and numbers as text; anything else is empty.
fn text(v: Option<&CFType>) -> String {
    let Some(v) = v else { return String::new() };
    let r = v.as_CFTypeRef();
    let t = type_of(r);
    if t == unsafe { CFStringGetTypeID() } {
        let s = unsafe { CFString::wrap_under_get_rule(r as CFStringRef) };
        return s.to_string().trim().to_string();
    }
    if t == unsafe { CFNumberGetTypeID() } && t != unsafe { CFBooleanGetTypeID() } {
        let mut n = 0f64;
        unsafe { CFNumberGetValue(r as _, kCFNumberDoubleType, &mut n as *mut f64 as *mut c_void) };
        return if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") };
    }
    String::new()
}

fn boolean(v: Option<&CFType>) -> Option<bool> {
    let v = v?;
    if type_of(v.as_CFTypeRef()) != unsafe { CFBooleanGetTypeID() } {
        return None;
    }
    Some(unsafe { CFBoolean::wrap_under_get_rule(v.as_CFTypeRef() as _) } == CFBoolean::true_value())
}

fn elements_in(v: Option<&CFType>) -> Vec<Ax> {
    let Some(v) = v else { return vec![] };
    let r = v.as_CFTypeRef();
    if type_of(r) != unsafe { CFArrayGetTypeID() } {
        return vec![];
    }
    let n = unsafe { CFArrayGetCount(r as CFArrayRef) };
    (0..n)
        .filter_map(|i| {
            let p = unsafe { CFArrayGetValueAtIndex(r as CFArrayRef, i) };
            (!p.is_null() && type_of(p) == unsafe { AXUIElementGetTypeID() })
                .then(|| Ax(unsafe { CFType::wrap_under_get_rule(p) }))
        })
        .collect()
}

fn strings_in(r: CFArrayRef) -> Vec<String> {
    let n = unsafe { CFArrayGetCount(r) };
    (0..n)
        .map(|i| text(Some(&unsafe { CFType::wrap_under_get_rule(CFArrayGetValueAtIndex(r, i)) })))
        .collect()
}

fn ax_value<T: Default>(v: Option<&CFType>, kind: u32) -> Option<T> {
    let r = v?.as_CFTypeRef();
    if type_of(r) != unsafe { AXValueGetTypeID() } {
        return None;
    }
    let mut out = T::default();
    (unsafe { AXValueGetValue(r, kind, &mut out as *mut T as *mut c_void) } != 0).then_some(out)
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Pair {
    a: f64,
    b: f64,
}

fn frame(pos: Option<&CFType>, size: Option<&CFType>) -> Option<(f64, f64, f64, f64)> {
    let p: Pair = ax_value(pos, AX_POINT)?;
    let s: Pair = ax_value(size, AX_SIZE)?;
    Some((p.a, p.b, s.a, s.b))
}

impl Ax {
    fn app(pid: i32) -> Ax {
        let r = unsafe { AXUIElementCreateApplication(pid) };
        unsafe { AXUIElementSetMessagingTimeout(r, 1.5) };
        Ax(unsafe { CFType::wrap_under_create_rule(r) })
    }

    fn raw(&self) -> CFTypeRef {
        self.0.as_CFTypeRef()
    }

    fn copy(&self, attr: &str) -> Option<CFType> {
        let mut v: CFTypeRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(self.raw(), cfstr(attr).as_concrete_TypeRef(), &mut v) };
        (err == 0 && !v.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(v) })
    }

    fn copy_many(&self, names: &[CFString]) -> Vec<Option<CFType>> {
        let arr = core_foundation::array::CFArray::from_CFTypes(names);
        let mut out: CFArrayRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyMultipleAttributeValues(self.raw(), arr.as_concrete_TypeRef(), 0, &mut out) };
        if err != 0 || out.is_null() {
            return vec![None; names.len()];
        }
        let owned = unsafe { CFType::wrap_under_create_rule(out as CFTypeRef) };
        let r = owned.as_CFTypeRef() as CFArrayRef;
        (0..names.len() as isize)
            .map(|i| {
                if i >= unsafe { CFArrayGetCount(r) } {
                    return None;
                }
                let p = unsafe { CFArrayGetValueAtIndex(r, i) };
                if p.is_null() || (type_of(p) == unsafe { AXValueGetTypeID() } && unsafe { AXValueGetType(p) } == AX_ERROR) {
                    return None;
                }
                Some(unsafe { CFType::wrap_under_get_rule(p) })
            })
            .collect()
    }

    fn el(&self, attr: &str) -> Option<Ax> {
        let v = self.copy(attr)?;
        (type_of(v.as_CFTypeRef()) == unsafe { AXUIElementGetTypeID() }).then(|| Ax(v))
    }

    fn str(&self, attr: &str) -> String {
        text(self.copy(attr).as_ref())
    }

    fn set(&self, attr: &str, value: &CFType) -> i32 {
        unsafe { AXUIElementSetAttributeValue(self.raw(), cfstr(attr).as_concrete_TypeRef(), value.as_CFTypeRef()) }
    }

    fn perform(&self, action: &str) -> i32 {
        unsafe { AXUIElementPerformAction(self.raw(), cfstr(action).as_concrete_TypeRef()) }
    }

    fn actions(&self) -> Vec<String> {
        let mut out: CFArrayRef = std::ptr::null();
        if unsafe { AXUIElementCopyActionNames(self.raw(), &mut out) } != 0 || out.is_null() {
            return vec![];
        }
        let owned = unsafe { CFType::wrap_under_create_rule(out as CFTypeRef) };
        strings_in(owned.as_CFTypeRef() as CFArrayRef)
    }

    fn window_id(&self) -> Option<u32> {
        let mut id = 0u32;
        (unsafe { _AXUIElementGetWindow(self.raw(), &mut id) } == 0 && id != 0).then_some(id)
    }
}

// ---------------------------------------------------------------- apps

#[derive(Clone, Debug)]
pub struct App {
    pub name: String,
    pub pid: i32,
    pub bundle: String,
    pub active: bool,
}

pub fn apps() -> Vec<App> {
    let ws = NSWorkspace::sharedWorkspace();
    let front = ws.frontmostApplication().map(|a| a.processIdentifier());
    ws.runningApplications()
        .iter()
        .filter(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular)
        .map(|a| App {
            name: a.localizedName().map(|s| s.to_string()).unwrap_or_default(),
            pid: a.processIdentifier(),
            bundle: a.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default(),
            active: Some(a.processIdentifier()) == front,
        })
        .collect()
}

pub fn find_app(query: &str) -> Result<App, String> {
    let list = apps();
    if let Ok(pid) = query.parse::<i32>() {
        return list.into_iter().find(|a| a.pid == pid).ok_or(format!("No running app with pid {pid}."));
    }
    let q = query.to_lowercase();
    let exact = list.iter().find(|a| a.name.to_lowercase() == q || a.bundle.to_lowercase() == q);
    exact
        .or_else(|| list.iter().find(|a| a.name.to_lowercase().contains(&q)))
        .cloned()
        .ok_or(format!("\"{query}\" is not running. Use open first."))
}

/// Start or attach without bringing it forward, unless `front`.
pub fn open(name: &str, front: bool) -> Result<App, String> {
    if !front {
        if let Ok(app) = find_app(name) {
            return Ok(app);
        }
    }
    let mut cmd = Command::new("open");
    if !front {
        cmd.arg("-g");
    }
    let out = cmd.args(["-a", name]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(app) = find_app(name) {
            if !front || app.active {
                return Ok(app);
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("Opened \"{name}\" but it did not come up."))
}

// ---------------------------------------------------------------- permissions

pub fn trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

pub fn permissions(prompt: bool) -> (bool, bool) {
    if prompt {
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let opts = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
        let ax = unsafe { AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef()) != 0 };
        let screen = unsafe { CGPreflightScreenCaptureAccess() != 0 || CGRequestScreenCaptureAccess() != 0 };
        return (ax, screen);
    }
    (trusted(), unsafe { CGPreflightScreenCaptureAccess() != 0 })
}

fn require_trust() -> Result<(), String> {
    if trusted() {
        Ok(())
    } else {
        Err("Accessibility permission is missing: grant it to the app that runs your AI tool (System Settings > Privacy & Security > Accessibility), or run `agentcursor permissions`.".into())
    }
}

// ---------------------------------------------------------------- reading

pub struct Window {
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    ax: Ax,
}

pub struct Snapshot {
    pub app: App,
    pub window: Window,
    pub elements: Vec<Element>,
    pub handles: Vec<Ax>,
    pub truncated: bool,
}

fn actionable(role: &str) -> Option<&'static str> {
    Some(match role {
        "AXButton" => "button",
        "AXCheckBox" => "checkbox",
        "AXRadioButton" => "radio",
        "AXPopUpButton" => "popup",
        "AXMenuButton" => "menubutton",
        "AXTextField" => "textfield",
        "AXTextArea" => "textarea",
        "AXComboBox" => "combobox",
        "AXSlider" => "slider",
        "AXLink" => "link",
        "AXMenuItem" => "menuitem",
        "AXDisclosureTriangle" => "disclosure",
        "AXIncrementor" => "stepper",
        "AXColorWell" => "color",
        "AXDateField" => "datefield",
        "AXMenuBarItem" => "menubaritem",
        _ => return None,
    })
}

const WITH_VALUE: [&str; 8] = ["textfield", "textarea", "combobox", "checkbox", "radio", "slider", "popup", "datefield"];
const NAMES: [&str; 11] = [
    "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXPosition", "AXSize", "AXEnabled",
    "AXFocused", "AXChildren",
];

type Rect = (f64, f64, f64, f64);

fn intersects(a: Rect, b: Rect) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

fn intersection(a: Rect, b: Rect) -> Rect {
    let (x, y) = (a.0.max(b.0), a.1.max(b.1));
    let (r, btm) = ((a.0 + a.2).min(b.0 + b.2), (a.1 + a.3).min(b.1 + b.3));
    (x, y, (r - x).max(0.0), (btm - y).max(0.0))
}

struct Walker {
    names: Vec<CFString>,
    out: Vec<(Element, Ax)>,
    visited: usize,
    truncated: bool,
    max: usize,
}

impl Walker {
    fn walk(&mut self, el: &Ax, clip: Rect, depth: usize, inside: bool) {
        if self.visited >= 6000 || depth > 60 || self.out.len() >= self.max {
            self.truncated = true;
            return;
        }
        self.visited += 1;
        let a = self.names.clone();
        let a = el.copy_many(&a);
        let role = text(a[0].as_ref());
        let r = frame(a[6].as_ref(), a[7].as_ref());
        if let Some(r) = r {
            if r.2 > 0.0 && r.3 > 0.0 && !intersects(r, clip) {
                return;
            }
        }
        let child_clip = match r {
            Some(r) if role == "AXScrollArea" && r.2 > 0.0 && r.3 > 0.0 => intersection(clip, r),
            _ => clip,
        };
        let mut kind = actionable(&role);
        let mut name = [2, 3, 5].iter().map(|&i| text(a[i].as_ref())).find(|s| !s.is_empty()).unwrap_or_default();
        if kind.is_none() && !inside {
            if role == "AXStaticText" || role == "AXHeading" {
                // A heading's value is its level, not its text.
                let v = if role == "AXHeading" { String::new() } else { text(a[4].as_ref()) };
                if !v.is_empty() || !name.is_empty() {
                    kind = Some(if role == "AXHeading" { "heading" } else { "text" });
                    if !v.is_empty() {
                        name = v;
                    }
                }
            } else if role == "AXImage" && !text(a[2].as_ref()).is_empty() {
                kind = Some("image");
                name = text(a[2].as_ref());
            }
        }
        if let (Some(kind), Some(r)) = (kind, r) {
            if r.2 > 1.0 && r.3 > 1.0 {
                let value = WITH_VALUE
                    .contains(&kind)
                    .then(|| text(a[4].as_ref()).chars().take(200).collect::<String>())
                    .filter(|v| !v.is_empty());
                self.out.push((
                    Element {
                        role: kind.into(),
                        name: name.chars().take(120).collect(),
                        value,
                        x: r.0.round(),
                        y: r.1.round(),
                        w: r.2.round(),
                        h: r.3.round(),
                        disabled: boolean(a[8].as_ref()) == Some(false),
                        focused: boolean(a[9].as_ref()) == Some(true),
                        ..Default::default()
                    },
                    el.clone(),
                ));
            }
        }
        let inside = inside || actionable(&role).is_some();
        for child in elements_in(a[10].as_ref()) {
            self.walk(&child, child_clip, depth + 1, inside);
        }
    }
}

/// The app element, and whether its tree was only just switched on (it then fills in over seconds).
fn app_ax(pid: i32) -> (Ax, bool) {
    let app = Ax::app(pid);
    let on = |attr: &str| boolean(app.copy(attr).as_ref()) == Some(true);
    let yes = CFBoolean::true_value().as_CFType();
    // Electron builds its tree for AXManualAccessibility. Chrome rejects that attribute
    // (as Safari does) and exposes page content only after AXEnhancedUserInterface.
    let mut flipped = !on("AXManualAccessibility") && app.set("AXManualAccessibility", &yes) == 0;
    if !on("AXEnhancedUserInterface") && is_chromium(pid) {
        // Chrome applies it but answers kAXErrorNotImplemented, so read it back.
        app.set("AXEnhancedUserInterface", &yes);
        flipped |= on("AXEnhancedUserInterface");
    }
    (app, flipped)
}

/// Chromium browsers and Electron apps ship a "Helper (Renderer)" app in their bundle.
fn is_chromium(pid: i32) -> bool {
    use std::fs::read_dir;
    use std::path::Path;
    let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else { return false };
    let Some(path) = app.bundleURL().and_then(|u| u.path()) else { return false };
    let frameworks = Path::new(&path.to_string()).join("Contents/Frameworks");
    let has_renderer = |dir: &Path| {
        read_dir(dir).into_iter().flatten().flatten().any(|e| e.file_name().to_string_lossy().ends_with("Helper (Renderer).app"))
    };
    has_renderer(&frameworks)
        || read_dir(&frameworks).into_iter().flatten().flatten().any(|f| {
            read_dir(f.path().join("Versions"))
                .into_iter()
                .flatten()
                .flatten()
                .any(|v| has_renderer(&v.path().join("Helpers")))
        })
}

fn focused_window(app: &Ax) -> Option<Ax> {
    app.el("AXFocusedWindow")
        .or_else(|| app.el("AXMainWindow"))
        .or_else(|| elements_in(app.copy("AXWindows").as_ref()).into_iter().next())
}

fn walk_app(ax: &Ax, max: usize) -> Option<(Ax, Walker)> {
    let win = focused_window(ax)?;
    let (x, y, w, h) = frame(win.copy("AXPosition").as_ref(), win.copy("AXSize").as_ref()).unwrap_or_default();
    let mut walker = Walker { names: NAMES.iter().map(|n| cfstr(n)).collect(), out: vec![], visited: 0, truncated: false, max };
    walker.walk(&win, (x, y, w, h), 0, false);
    let everywhere = (-1e5, -1e5, 2e5, 2e5);
    for child in elements_in(ax.copy("AXChildren").as_ref()) {
        if child.str("AXRole") == "AXMenu" {
            walker.walk(&child, everywhere, 0, false);
        }
    }
    Some((win, walker))
}

pub fn snapshot(app: &App, max: usize) -> Result<Snapshot, String> {
    require_trust()?;
    let (ax, just_enabled) = app_ax(app.pid);
    let mut walker = walk_app(&ax, max);
    if just_enabled {
        // Wait for the tree to start growing, then until it stops: at most 5s, once per app.
        let mut grown = false;
        for _ in 0..10 {
            std::thread::sleep(Duration::from_millis(500));
            let next = walk_app(&ax, max);
            let grew = next.as_ref().map_or(0, |w| w.1.out.len()) > walker.as_ref().map_or(0, |w| w.1.out.len());
            walker = next;
            if grew {
                grown = true;
            } else if grown {
                break;
            }
        }
    }
    let (win, walker) = walker.ok_or(format!("{} has no open window.", app.name))?;
    let (x, y, w, h) = frame(win.copy("AXPosition").as_ref(), win.copy("AXSize").as_ref()).unwrap_or_default();
    let (elements, handles) = walker.out.into_iter().unzip();
    Ok(Snapshot {
        app: app.clone(),
        window: Window { title: win.str("AXTitle"), x, y, w, h, ax: win },
        elements,
        handles,
        truncated: walker.truncated,
    })
}

// ---------------------------------------------------------------- acting without the pointer

/// AXPress on the element or the nearest ancestor that takes it (a label inside a list row).
pub fn press(h: &Ax) -> bool {
    // Text inside a link or button: press the control. Chrome accepts a press on the text
    // but may not follow the link (Wikipedia's search suggestions filled the box, no navigation).
    let mut start = h.clone();
    if actionable(&h.str("AXRole")).is_none() {
        let mut up = h.el("AXParent");
        for _ in 0..3 {
            let Some(p) = up else { break };
            if actionable(&p.str("AXRole")).is_some() {
                start = p;
                break;
            }
            up = p.el("AXParent");
        }
    }
    let mut cur = Some(start);
    for _ in 0..4 {
        let Some(el) = cur else { break };
        if el.actions().iter().any(|a| a == "AXPress") && el.perform("AXPress") == 0 {
            return true;
        }
        cur = el.el("AXParent");
    }
    false
}

pub fn show_menu(h: &Ax) -> bool {
    h.perform("AXShowMenu") == 0
}

pub fn scroll_into_view(h: &Ax) {
    h.perform("AXScrollToVisible");
}

pub fn focused_element(pid: i32) -> Option<Ax> {
    Ax::app(pid).el("AXFocusedUIElement")
}

/// Focus the field and set its value; false when the app does not allow it.
/// Focus the field and set its text. `human` grows it a character at a time with typing
/// pauses, so every step fires the page's input event the way keystrokes do.
/// False when the field refuses (nothing was typed then).
pub fn set_text(h: &Ax, value: &str, replace: bool, human: bool) -> bool {
    h.set("AXFocused", &CFBoolean::true_value().as_CFType());
    let base = if replace { String::new() } else { h.str("AXValue") };
    if !human {
        return h.set("AXValue", &cfstr(&format!("{base}{value}")).as_CFType()) == 0;
    }
    let mut rng = crate::motion::Rng::fresh();
    let mut typed = String::new();
    for (i, ch) in value.chars().enumerate() {
        typed.push(ch);
        if h.set("AXValue", &cfstr(&format!("{base}{typed}")).as_CFType()) != 0 && i == 0 {
            return false;
        }
        let pause = rng.range(45.0, 120.0) + if ch == ' ' { rng.range(40.0, 120.0) } else { 0.0 };
        std::thread::sleep(Duration::from_millis(pause as u64));
    }
    true
}

pub fn confirm(h: &Ax) -> bool {
    h.actions().iter().any(|a| a == "AXConfirm") && h.perform("AXConfirm") == 0
}

// ---------------------------------------------------------------- events posted to one process

fn source() -> CGEventSource {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).expect("event source")
}

pub fn post_move(pid: i32, x: f64, y: f64) {
    if let Ok(e) = CGEvent::new_mouse_event(source(), CGEventType::MouseMoved, CGPoint::new(x, y), CGMouseButton::Left) {
        e.post_to_pid(pid);
    }
}

pub fn post_click(pid: i32, x: f64, y: f64, right: bool, double: bool, press_ms: u64) {
    let (down, up, button) = if right {
        (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right)
    } else {
        (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left)
    };
    for n in 1..=if double { 2 } else { 1 } {
        for (kind, wait) in [(down, press_ms), (up, 0)] {
            if let Ok(e) = CGEvent::new_mouse_event(source(), kind, CGPoint::new(x, y), button) {
                e.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, n);
                e.post_to_pid(pid);
            }
            std::thread::sleep(Duration::from_millis(wait));
        }
    }
}

pub fn post_scroll(pid: i32, dx: f64, dy: f64, steps: u32) {
    let steps = steps.max(1);
    for _ in 0..steps {
        let (wy, wx) = ((-dy / steps as f64) as i32, (-dx / steps as f64) as i32);
        if let Ok(e) = CGEvent::new_scroll_event(source(), ScrollEventUnit::PIXEL, 2, wy, wx, 0) {
            e.post_to_pid(pid);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn post_text(pid: i32, text: &str, per_key_ms: u64) {
    for ch in text.chars() {
        let s = ch.to_string();
        for down in [true, false] {
            if let Ok(e) = CGEvent::new_keyboard_event(source(), 0, down) {
                e.set_string(&s);
                e.post_to_pid(pid);
            }
        }
        std::thread::sleep(Duration::from_millis(per_key_ms));
    }
}

fn key_code(name: &str) -> Option<u16> {
    Some(match name {
        "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5, "z" => 6, "x" => 7, "c" => 8, "v" => 9,
        "b" => 11, "q" => 12, "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17, "o" => 31, "u" => 32,
        "i" => 34, "p" => 35, "l" => 37, "j" => 38, "k" => 40, "n" => 45, "m" => 46,
        "1" => 18, "2" => 19, "3" => 20, "4" => 21, "5" => 23, "6" => 22, "7" => 26, "8" => 28, "9" => 25, "0" => 29,
        "enter" | "return" => 36, "tab" => 48, "space" => 49, "backspace" | "delete" => 51, "escape" | "esc" => 53,
        "left" => 123, "right" => 124, "down" => 125, "up" => 126, "home" => 115, "end" => 119,
        "pageup" => 116, "pagedown" => 121,
        _ => return None,
    })
}

/// "cmd+shift+t" as a key code and modifier flags.
pub fn parse_combo(combo: &str) -> Result<(u16, u64), String> {
    let (mut flags, mut code) = (0u64, None);
    for part in combo.to_lowercase().split('+').map(str::trim) {
        match part {
            "cmd" | "command" | "meta" => flags |= CGEventFlags::CGEventFlagCommand.bits(),
            "shift" => flags |= CGEventFlags::CGEventFlagShift.bits(),
            "alt" | "option" => flags |= CGEventFlags::CGEventFlagAlternate.bits(),
            "ctrl" | "control" => flags |= CGEventFlags::CGEventFlagControl.bits(),
            other => code = Some(key_code(other).ok_or(format!("No key named '{other}' in '{combo}'."))?),
        }
    }
    Ok((code.ok_or(format!("'{combo}' has modifiers but no key."))?, flags))
}

pub fn post_combo(pid: i32, combo: &str) -> Result<(), String> {
    let (code, flags) = parse_combo(combo)?;
    for down in [true, false] {
        if let Ok(e) = CGEvent::new_keyboard_event(source(), code, down) {
            e.set_flags(CGEventFlags::from_bits_truncate(flags));
            e.post_to_pid(pid);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- screenshots

/// JPEG of the window (or a region of the screen), downscaled; works while the window is covered.
pub fn screenshot(snap: &Snapshot, region: Option<Rect>, max_width: u32) -> Result<(Vec<u8>, String), String> {
    let file = crate::view::state_dir().join(format!("shot-{}.jpg", std::process::id()));
    let mut cmd = Command::new("screencapture");
    cmd.args(["-x", "-o", "-t", "jpg"]);
    let covers = match (region, snap.window.ax.window_id()) {
        (None, Some(id)) => {
            cmd.arg(format!("-l{id}"));
            (snap.window.x, snap.window.y, snap.window.w, snap.window.h)
        }
        (r, _) => {
            let r = r.unwrap_or((snap.window.x, snap.window.y, snap.window.w, snap.window.h));
            cmd.arg(format!("-R{},{},{},{}", r.0, r.1, r.2, r.3));
            r
        }
    };
    let out = cmd.arg(&file).output().map_err(|e| e.to_string())?;
    if !out.status.success() || !file.exists() {
        return Err("Screen capture failed: grant Screen Recording to the app that runs your AI tool.".into());
    }
    let size = |f: &std::path::Path| -> (f64, f64) {
        let o = Command::new("sips").args(["-g", "pixelWidth", "-g", "pixelHeight"]).arg(f).output().ok();
        let s = o.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        let grab = |k: &str| s.lines().find_map(|l| l.trim().strip_prefix(k)?.trim().parse::<f64>().ok()).unwrap_or(0.0);
        (grab("pixelWidth:"), grab("pixelHeight:"))
    };
    if size(&file).0 > max_width as f64 {
        let _ = Command::new("sips").args(["--resampleWidth", &max_width.to_string()]).arg(&file).output();
    }
    let (iw, ih) = size(&file);
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&file);
    let scale = if iw > 0.0 { covers.2 / iw } else { 1.0 };
    let note = format!(
        "image {iw}x{ih} covers screen {},{} {}x{}. Screen x = {} + px*{scale:.3}, y = {} + py*{scale:.3}.",
        covers.0, covers.1, covers.2, covers.3, covers.0, covers.1
    );
    Ok((bytes, note))
}

// ---------------------------------------------------------------- the agent's own cursor

mod overlay {
    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSBezierPath, NSColor, NSEventMask, NSResponder,
        NSScreen, NSScreenSaverWindowLevel, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSObject, NSPoint, NSRect, NSSize};
    use std::sync::mpsc::{Receiver, RecvTimeoutError};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    static COLOR: OnceLock<(f64, f64, f64)> = OnceLock::new();
    const W: f64 = 22.0;
    const H: f64 = 26.0;

    define_class!(
        #[unsafe(super(NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AgentCursorArrow"]
        struct Arrow;

        impl Arrow {
            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty: NSRect) {
                let (r, g, b) = *COLOR.get().unwrap_or(&(0.29, 0.87, 0.5));
                let p = NSBezierPath::bezierPath();
                for (i, (x, y)) in [(2.0, 2.0), (2.0, 19.0), (6.0, 15.0), (9.0, 21.0), (12.0, 20.0), (9.0, 14.0), (15.0, 14.0)]
                    .into_iter()
                    .enumerate()
                {
                    let pt = NSPoint::new(x, H - y);
                    if i == 0 { p.moveToPoint(pt) } else { p.lineToPoint(pt) }
                }
                p.closePath();
                NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0).setFill();
                p.fill();
                NSColor::colorWithSRGBRed_green_blue_alpha(0.0, 0.0, 0.0, 0.85).setStroke();
                p.setLineWidth(1.2);
                p.stroke();
            }
        }
    );

    pub fn parse_hex(hex: &str) -> Option<(f64, f64, f64)> {
        let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).ok()?;
        Some((((v >> 16) & 255) as f64 / 255.0, ((v >> 8) & 255) as f64 / 255.0, (v & 255) as f64 / 255.0))
    }

    /// Runs on the main thread until no position arrives for `idle`.
    pub fn run(rx: Receiver<(f64, f64)>, color: Option<&str>, idle: Duration) {
        if let Some(c) = color.and_then(parse_hex) {
            let _ = COLOR.set(c);
        }
        let mtm = MainThreadMarker::new().expect("overlay must run on the main thread");
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        app.finishLaunching();
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(W, H));
        let win = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                rect,
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { win.setReleasedWhenClosed(false) };
        win.setOpaque(false);
        win.setBackgroundColor(Some(&NSColor::clearColor()));
        win.setHasShadow(false);
        win.setIgnoresMouseEvents(true);
        win.setLevel(NSScreenSaverWindowLevel);
        win.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        let view: Retained<Arrow> = unsafe { msg_send![Arrow::alloc(mtm), initWithFrame: rect] };
        win.setContentView(Some(&view));
        // Accessibility coordinates start top-left of the primary screen; AppKit's start bottom-left.
        let primary_h = NSScreen::screens(mtm).firstObject().map(|s| s.frame().size.height).unwrap_or(1080.0);
        let mut shown = false;
        let mut last = Instant::now();
        loop {
            while let Some(ev) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
                NSEventMask::Any,
                Some(&NSDate::dateWithTimeIntervalSinceNow(0.0)),
                unsafe { NSDefaultRunLoopMode },
                true,
            ) {
                app.sendEvent(&ev);
            }
            let mut at = None;
            match rx.recv_timeout(Duration::from_millis(8)) {
                Ok(p) => at = Some(p),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            while let Ok(p) = rx.try_recv() {
                at = Some(p);
            }
            if let Some((x, y)) = at {
                last = Instant::now();
                win.setFrameOrigin(NSPoint::new(x - 2.0, primary_h - y - H + 2.0));
                if !shown {
                    win.orderFrontRegardless();
                    shown = true;
                }
            } else if last.elapsed() > idle {
                return;
            }
        }
    }
}

pub use overlay::run as run_overlay;
