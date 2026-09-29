//! Human cursor motion, ported from src/path-engine: Fitts timing, a bowed
//! Bezier path with eased velocity, jitter, and overshoot-then-correct.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub t: f64,
}

/// Seedable mulberry32, the same generator the TypeScript engine uses.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }

    pub fn fresh() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u32)
            .unwrap_or(0);
        Rng(nanos ^ std::process::id().rotate_left(16))
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut z = self.0;
        z = (z ^ (z >> 15)).wrapping_mul(z | 1);
        z ^= z.wrapping_add((z ^ (z >> 7)).wrapping_mul(z | 61));
        (z ^ (z >> 14)) as f64 / 4_294_967_296.0
    }

    pub fn range(&mut self, min: f64, max: f64) -> f64 {
        min + (max - min) * self.next()
    }

    pub fn gaussian(&mut self, mean: f64, std: f64) -> f64 {
        let u = 1.0 - self.next();
        let v = self.next();
        mean + std * (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }

    pub fn bool(&mut self, p: f64) -> bool {
        self.next() < p
    }
}

/// One persona: the same seed moves the same way, so a session reads as one person.
#[derive(Clone, Copy, Debug)]
pub struct Traits {
    pub speed: f64,
    pub curviness: f64,
    pub jitter: f64,
    pub overshoot_prob: f64,
    pub overshoot_mag: f64,
    pub precision: f64,
    pub handedness: f64,
}

impl Traits {
    pub fn from_seed(seed: u32) -> Self {
        let mut r = Rng::new(seed);
        Traits {
            speed: r.range(0.75, 1.35),
            curviness: r.range(0.6, 1.5),
            jitter: r.range(0.7, 2.2),
            overshoot_prob: r.range(0.25, 0.7),
            overshoot_mag: r.range(0.08, 0.16),
            precision: r.range(0.1, 0.26),
            handedness: if r.bool(0.5) { 1.0 } else { -1.0 },
        }
    }
}

const OVERSHOOT_MIN_DISTANCE: f64 = 180.0;

pub fn generate_move(from: (f64, f64), to: (f64, f64), target_width: f64, tr: &Traits, rng: &mut Rng) -> Vec<Sample> {
    let total = dist(from, to);
    let mut legs = vec![(from, to, false)];
    if total > OVERSHOOT_MIN_DISTANCE && rng.bool(tr.overshoot_prob) {
        let past = overshoot_point(from, to, rng, tr.overshoot_mag);
        legs = vec![(from, past, false), (past, to, true)];
    }
    let mut out: Vec<Sample> = Vec::new();
    let mut offset = 0.0;
    for (a, b, correction) in legs {
        for s in segment(a, b, target_width, correction, tr, rng) {
            out.push(Sample { t: s.t + offset, ..s });
        }
        offset = out.last().map_or(offset, |s| s.t) + rng.range(12.0, 45.0);
    }
    let mut last = -1.0;
    for s in &mut out {
        if s.t <= last {
            s.t = last + 1.0;
        }
        last = s.t;
    }
    out
}

fn segment(a: (f64, f64), b: (f64, f64), width: f64, correction: bool, tr: &Traits, rng: &mut Rng) -> Vec<Sample> {
    let d = dist(a, b);
    let w = if correction { width.max(12.0) } else { width };
    let fitts = (rng.range(70.0, 130.0) + rng.range(80.0, 150.0) * (d / w.max(6.0) + 1.0).log2()) / tr.speed;
    let duration = fitts.max(90.0) * if correction { 0.55 } else { 1.0 };
    let steps = (duration / rng.range(14.0, 20.0)).clamp(8.0, 140.0).round() as usize;
    let skew = rng.range(0.85, 1.18);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx.hypot(dy).max(1e-4);
    let (nx, ny) = (-dy / len, dx / len);
    let side = if rng.bool(0.75) { tr.handedness } else { -tr.handedness };
    let bow = side * rng.range(d * 0.04, d * 0.16) * tr.curviness;
    let c1 = (a.0 + dx * 0.3 + nx * bow * rng.range(0.7, 1.0), a.1 + dy * 0.3 + ny * bow * rng.range(0.7, 1.0));
    let c2 = (a.0 + dx * 0.68 + nx * bow * rng.range(0.6, 1.0), a.1 + dy * 0.68 + ny * bow * rng.range(0.6, 1.0));

    let mut out = Vec::with_capacity(steps + 1);
    let mut t = 0.0;
    for i in 0..=steps {
        let tf = i as f64 / steps as f64;
        let e = smootherstep(tf).powf(skew);
        let u = 1.0 - e;
        let px = u * u * u * a.0 + 3.0 * u * u * e * c1.0 + 3.0 * u * e * e * c2.0 + e * e * e * b.0;
        let py = u * u * u * a.1 + 3.0 * u * u * e * c1.1 + 3.0 * u * e * e * c2.1 + e * e * e * b.1;
        let envelope = (std::f64::consts::PI * tf).sin();
        if i > 0 {
            t += duration / steps as f64 * rng.range(0.7, 1.3);
        }
        out.push(Sample {
            x: px + rng.gaussian(0.0, tr.jitter) * envelope,
            y: py + rng.gaussian(0.0, tr.jitter) * envelope,
            t,
        });
    }
    out[0] = Sample { x: a.0, y: a.1, t: 0.0 };
    out[steps] = Sample { x: b.0, y: b.1, t };
    out
}

fn overshoot_point(from: (f64, f64), to: (f64, f64), rng: &mut Rng, mag: f64) -> (f64, f64) {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let len = dx.hypot(dy).max(1e-4);
    let (ux, uy) = (dx / len, dy / len);
    let over = (len * mag).min(110.0) * rng.range(0.5, 1.1);
    let perp = rng.gaussian(0.0, 8.0);
    (to.0 + ux * over - uy * perp, to.1 + uy * over + ux * perp)
}

/// A point inside the rect, off dead-centre the way people miss the middle.
pub fn off_center(x: f64, y: f64, w: f64, h: f64, rng: &mut Rng, precision: f64) -> (f64, f64) {
    let ox = rng.gaussian(0.0, w * precision).clamp(-w * 0.4, w * 0.4);
    let oy = rng.gaussian(0.0, h * precision).clamp(-h * 0.4, h * 0.4);
    (x + w / 2.0 + ox, y + h / 2.0 + oy)
}

fn smootherstep(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

pub fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    (b.0 - a.0).hypot(b.1 - a.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulberry32_matches_typescript() {
        // createRng(42).next() in src/path-engine/rng.ts
        let mut r = Rng::new(42);
        assert!((r.next() - 0.6011037519201636).abs() < 1e-12);
    }

    #[test]
    fn move_starts_ends_and_keeps_time_moving() {
        let tr = Traits::from_seed(7);
        for seed in 0..50 {
            let s = generate_move((10.0, 20.0), (900.0, 600.0), 24.0, &tr, &mut Rng::new(seed));
            assert_eq!((s[0].x, s[0].y, s[0].t), (10.0, 20.0, 0.0));
            let last = s.last().unwrap();
            assert_eq!((last.x, last.y), (900.0, 600.0));
            assert!(s.windows(2).all(|w| w[1].t > w[0].t));
            assert!(last.t > 90.0 && last.t < 4000.0, "duration {}", last.t);
        }
    }

    #[test]
    fn same_seed_same_path() {
        let tr = Traits::from_seed(1);
        let a = generate_move((0.0, 0.0), (400.0, 300.0), 20.0, &tr, &mut Rng::new(9));
        let b = generate_move((0.0, 0.0), (400.0, 300.0), 20.0, &tr, &mut Rng::new(9));
        assert_eq!(a, b);
    }

    #[test]
    fn off_center_stays_inside() {
        let mut r = Rng::new(3);
        for _ in 0..500 {
            let (x, y) = off_center(100.0, 50.0, 80.0, 20.0, &mut r, 0.26);
            assert!((100.0..=180.0).contains(&x) && (50.0..=70.0).contains(&y));
        }
    }
}
