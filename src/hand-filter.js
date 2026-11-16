// Pure landmark post-processing: One Euro smoothing and a tracking-quality read. No window/document.
// One Euro filter (Casiez, Roussel, Vogel, CHI 2012): a low-pass whose cutoff rises with speed, so a still
// hand stops jittering while a fast move (the zip pull) is barely delayed.
// cutoff = minCutoff + beta * |speed|; speed itself is low-passed at dCutoff. Units: Hz, value units / s.

const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export function createOneEuro({ minCutoff, beta, dCutoff = 1 }) {
  let x = null, dx = 0, t0 = 0;
  return (v, t) => {
    if (x === null || t <= t0) { // first sample, or a timestamp that did not advance: take it as is
      if (x === null) x = v;
      t0 = t;
      return x;
    }
    const dt = t - t0;
    t0 = t;
    dx += alpha(dCutoff, dt) * ((v - x) / dt - dx);
    x += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x);
    return x;
  };
}

// Tuned on synthetic 60 fps tracks (tests/hand-filter.test.js): image coords are screen fractions,
// world coords metres around the hand centre (fingers move ~0.5 m/s, so world beta is larger).
export const FILTER_2D = { minCutoff: 1.5, beta: 8, dCutoff: 1 };
export const FILTER_WORLD = { minCutoff: 1.5, beta: 40, dCutoff: 1 };

// One filter per coordinate of each of the 21 points.
function createPointsFilter(params) {
  let fs = null;
  return (pts, t) => {
    fs ??= pts.map(() => [createOneEuro(params), createOneEuro(params), createOneEuro(params)]);
    return pts.map((p, i) => ({ ...p, x: fs[i][0](p.x, t), y: fs[i][1](p.y, t), z: fs[i][2](p.z ?? 0, t) }));
  };
}

// Smooths a whole detection: hands = [{landmarks, world?, ...}], t in seconds. Each hand keeps its filter
// state by matching its wrist to the nearest previous hand (within maxDist screen fraction); unmatched hands
// start fresh and vanished ones are dropped. Returns new hand objects with smoothed landmarks/world and
// the unfiltered landmarks as `raw`.
export function createHandsFilter({ p2d = FILTER_2D, world = FILTER_WORLD, maxDist = 0.2 } = {}) {
  let slots = [];
  return (hands, t) => {
    const next = [], used = new Set();
    const out = hands.map((h) => {
      const w = h.landmarks[0];
      let best = null, bd = maxDist ** 2;
      for (const s of slots) {
        const d = (s.wrist.x - w.x) ** 2 + (s.wrist.y - w.y) ** 2;
        if (!used.has(s) && d <= bd) { best = s; bd = d; }
      }
      const s = best ?? { f2d: createPointsFilter(p2d), fw: createPointsFilter(world) };
      used.add(s);
      const landmarks = s.f2d(h.landmarks, t);
      s.wrist = landmarks[0];
      next.push(s);
      return { ...h, raw: h.landmarks, landmarks, world: h.world && s.fw(h.world, t) };
    });
    slots = next;
    return out;
  };
}

// Tracking quality of one hand for the HUD. The Tasks API does not expose the landmark model's presence
// score, so the handedness score stands in: it falls with the landmark confidence when tracking is poor.
// edge: a landmark within `margin` of the frame border (the model loses fingers there).
export function handQuality(lms, score = 1, margin = 0.03) {
  const edge = lms.some((p) => p.x < margin || p.x > 1 - margin || p.y < margin || p.y > 1 - margin);
  const level = score >= 0.9 && !edge ? 'good' : score >= 0.7 ? 'fair' : 'poor';
  return { level, edge };
}
