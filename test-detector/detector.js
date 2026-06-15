// Records pointer telemetry and scores the movement before each click on the
// same features behavioral bot detection looks at. No build step — open the
// file directly, or serve the folder, and drive it with AgentCursor.

const IDLE_GAP_MS = 500;
let path = [];
let lastMoveAt = 0;
let count = 0;

addEventListener("mousemove", (e) => {
  const now = performance.now();
  if (now - lastMoveAt > IDLE_GAP_MS) path = [];
  lastMoveAt = now;
  path.push({ x: e.clientX, y: e.clientY, t: now });
});

addEventListener(
  "click",
  (e) => {
    const target = e.target.closest(".target");
    if (!target) return;
    const metrics = score(path.slice(), e, target);
    render(metrics);
    path = [];
  },
  true,
);

function score(samples, clickEvent, target) {
  const rect = target.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const offset = Math.hypot(clickEvent.clientX - cx, clickEvent.clientY - cy);

  const pathLen = totalLength(samples);
  const chord = samples.length > 1 ? dist(samples[0], samples.at(-1)) : 0;
  const straightness = pathLen > 0 ? chord / pathLen : 1;
  const speeds = stepSpeeds(samples);
  const speedCV = cv(speeds);
  const dwellMs = samples.length ? Math.max(0, performance.now() - samples.at(-1).t) : 0;
  const overshoot = detectOvershoot(samples);

  const humanSignals = [
    samples.length >= 6,
    straightness < 0.985,
    speedCV > 0.12,
    dwellMs > 12,
    offset > 1.2,
  ].filter(Boolean).length;

  return {
    n: samples.length,
    straightness,
    speedCV,
    dwellMs,
    offset,
    overshoot,
    trusted: clickEvent.isTrusted,
    human: humanSignals >= 4,
  };
}

function render(m) {
  count++;
  const tr = document.createElement("tr");
  const cells = [
    count,
    m.n,
    m.straightness.toFixed(3),
    m.speedCV.toFixed(2),
    Math.round(m.dwellMs),
    m.offset.toFixed(1),
    m.overshoot ? "yes" : "no",
    m.trusted ? "yes" : "no",
  ];
  for (const c of cells) {
    const td = document.createElement("td");
    td.textContent = String(c);
    tr.appendChild(td);
  }
  const verdict = document.createElement("td");
  verdict.textContent = m.human ? "human-like" : "bot-like";
  verdict.className = m.human ? "ok" : "bad";
  tr.appendChild(verdict);
  document.getElementById("rows").prepend(tr);
}

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function totalLength(s) {
  let total = 0;
  for (let i = 1; i < s.length; i++) total += dist(s[i - 1], s[i]);
  return total;
}

function stepSpeeds(s) {
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].t - s[i - 1].t;
    out.push(dist(s[i - 1], s[i]) / Math.max(dt, 1));
  }
  return out;
}

function cv(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function detectOvershoot(s) {
  if (s.length < 4) return false;
  const end = s.at(-1);
  const finalDist = dist(s[0], end);
  return s.some((p) => dist(s[0], p) > finalDist + 6);
}
