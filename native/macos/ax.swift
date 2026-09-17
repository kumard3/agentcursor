import AppKit
import ApplicationServices

let args = Array(CommandLine.arguments.dropFirst())

func emit(_ obj: Any) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

func fail(_ msg: String) -> Never {
    FileHandle.standardOutput.write(Data("{\"error\":\(String(reflecting: msg))}\n".utf8))
    exit(1)
}

func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func regularApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
}

func targetApp() -> NSRunningApplication? {
    if let p = opt("--pid"), let pid = pid_t(p) { return NSRunningApplication(processIdentifier: pid) }
    if let raw = opt("--app") {
        let name = raw.lowercased()
        let apps = regularApps()
        return apps.first { $0.localizedName?.lowercased() == name || $0.bundleIdentifier?.lowercased() == name }
            ?? apps.first { $0.localizedName?.lowercased().contains(name) ?? false }
    }
    return NSWorkspace.shared.frontmostApplication
}

let names = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue",
             "AXPosition", "AXSize", "AXEnabled", "AXFocused", "AXChildren"]

func attributes(_ el: AXUIElement) -> [AnyObject?] {
    var out: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
    guard err == .success, let values = out as? [AnyObject], values.count == names.count else {
        return Array(repeating: nil, count: names.count)
    }
    return values.map { v in
        if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
        return v
    }
}

func text(_ v: AnyObject?) -> String {
    if let s = v as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
    if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.stringValue }
    return ""
}

func frame(_ pos: AnyObject?, _ size: AnyObject?) -> CGRect? {
    guard let pos, let size, CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    guard AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) else { return nil }
    return CGRect(origin: p, size: s)
}

func element(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
    var v: AnyObject?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let v,
          CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func elements(_ el: AXUIElement, _ attr: String) -> [AXUIElement] {
    var v: AnyObject?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return [] }
    return (v as? [AXUIElement]) ?? []
}

let actionable: [String: String] = [
    "AXButton": "button", "AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXPopUpButton": "popup",
    "AXMenuButton": "menubutton", "AXTextField": "textfield", "AXTextArea": "textarea", "AXComboBox": "combobox",
    "AXSlider": "slider", "AXLink": "link", "AXMenuItem": "menuitem", "AXDisclosureTriangle": "disclosure",
    "AXIncrementor": "stepper", "AXColorWell": "color", "AXDateField": "datefield", "AXMenuBarItem": "menubaritem",
]
let withValue: Set<String> = ["textfield", "textarea", "combobox", "checkbox", "radio", "slider", "popup", "datefield"]

final class Walker {
    var out: [[String: Any]] = []
    var visited = 0
    var truncated = false
    let max: Int

    init(max: Int) { self.max = max }

    func walk(_ el: AXUIElement, clip: CGRect, depth: Int, insideControl: Bool) {
        if visited >= 6000 || depth > 60 { truncated = true; return }
        if out.count >= max { truncated = true; return }
        visited += 1
        let a = attributes(el)
        let role = (a[0] as? String) ?? ""
        let r = frame(a[6], a[7])
        if let r, r.width > 0, r.height > 0, !r.intersects(clip) { return }
        var childClip = clip
        if role == "AXScrollArea", let r, r.width > 0, r.height > 0 { childClip = clip.intersection(r) }

        var kind = actionable[role]
        var name = [text(a[2]), text(a[3]), text(a[5])].first { !$0.isEmpty } ?? ""
        if kind == nil, !insideControl {
            if role == "AXStaticText" || role == "AXHeading" {
                let v = text(a[4])
                if !v.isEmpty || !name.isEmpty { kind = role == "AXHeading" ? "heading" : "text"; name = v.isEmpty ? name : v }
            } else if role == "AXImage", !text(a[2]).isEmpty {
                kind = "image"
                name = text(a[2])
            }
        }
        if let kind, let r, r.width > 1, r.height > 1 {
            var e: [String: Any] = ["role": kind, "name": String(name.prefix(120)),
                                    "x": Int(r.minX.rounded()), "y": Int(r.minY.rounded()),
                                    "w": Int(r.width.rounded()), "h": Int(r.height.rounded())]
            if withValue.contains(kind) { let v = text(a[4]); if !v.isEmpty { e["value"] = String(v.prefix(200)) } }
            if (a[8] as? Bool) == false { e["enabled"] = false }
            if (a[9] as? Bool) == true { e["focused"] = true }
            out.append(e)
        }
        let inside = insideControl || actionable[role] != nil
        for child in (a[10] as? [AXUIElement]) ?? [] {
            walk(child, clip: childClip, depth: depth + 1, insideControl: inside)
        }
    }
}

func focusedWindow(_ app: AXUIElement) -> AXUIElement? {
    element(app, "AXFocusedWindow") ?? element(app, "AXMainWindow") ?? elements(app, "AXWindows").first
}

func windowInfo(_ win: AXUIElement) -> [String: Any] {
    let a = attributes(win)
    let r = frame(a[6], a[7]) ?? .zero
    return ["title": text(a[2]), "x": Int(r.minX), "y": Int(r.minY), "w": Int(r.width), "h": Int(r.height)]
}

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
    ["name": app.localizedName ?? "", "pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier ?? ""]
}

func requireTrust() {
    if !AXIsProcessTrusted() {
        fail("Accessibility permission is missing. Run `agentcursor setup` and grant it to the app that runs your AI tool.")
    }
}

switch args.first ?? "" {
case "permissions":
    emit(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()])

case "request-accessibility":
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    emit(["accessibility": AXIsProcessTrustedWithOptions(opts)])

case "request-screen":
    emit(["screenRecording": CGRequestScreenCaptureAccess()])

case "apps":
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    emit(regularApps().map { appInfo($0).merging(["active": $0.processIdentifier == front]) { a, _ in a } })

case "activate":
    guard let app = targetApp() else { fail("app not found") }
    app.activate(options: [.activateAllWindows])
    let deadline = Date().addingTimeInterval(1.5)
    while Date() < deadline, NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    emit(appInfo(app).merging(["active": NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier]) { a, _ in a })

case "window":
    requireTrust()
    guard let app = targetApp() else { fail("app not found") }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    guard let win = focusedWindow(ax) else { fail("\(app.localizedName ?? "app") has no open window") }
    emit(appInfo(app).merging(["window": windowInfo(win)]) { a, _ in a })

case "snapshot":
    requireTrust()
    guard let app = targetApp() else { fail("app not found") }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 1.5)
    var current: AnyObject?
    let wasOn = AXUIElementCopyAttributeValue(ax, "AXManualAccessibility" as CFString, &current) == .success && (current as? Bool) == true
    if !wasOn, AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
        Thread.sleep(forTimeInterval: 0.8)
    }
    guard let win = focusedWindow(ax) else { fail("\(app.localizedName ?? "app") has no open window") }
    let max = Int(opt("--max") ?? "") ?? 300
    let screen = CGRect(x: -100_000, y: -100_000, width: 200_000, height: 200_000)
    let info = windowInfo(win)
    let winRect = CGRect(x: info["x"] as! Int, y: info["y"] as! Int, width: info["w"] as! Int, height: info["h"] as! Int)
    let walker = Walker(max: max)
    walker.walk(win, clip: winRect, depth: 0, insideControl: false)
    for child in elements(ax, "AXChildren") where (attributes(child)[0] as? String) == "AXMenu" {
        walker.walk(child, clip: screen, depth: 0, insideControl: false)
    }
    emit(appInfo(app).merging([
        "window": info, "elements": walker.out, "truncated": walker.truncated, "visited": walker.visited,
    ]) { a, _ in a })

default:
    fail("usage: agentcursor-ax permissions|request-accessibility|request-screen|apps|activate|window|snapshot [--pid N|--app NAME] [--max N]")
}
