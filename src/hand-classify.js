// Pure hand-gesture logic. No window/document: runs in Node tests.
// Coordinates: normalised [0,1], y down, in MIRRORED screen space (what the user sees in the preview).
// MediaPipe gives camera space, so pass its landmarks through mirror() first: raw x > 0.5 => side 'L'.
import { CFG } from './config.js';

const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]]; // MediaPipe [tip, pip] for index, middle, ring, pinky
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export const mirror = (lms) => lms.map((p) => ({ ...p, x: 1 - p.x }));

// handedness is accepted but unused: MediaPipe mislabels it often, so side comes from screen position.
export function classifyHand(lms, handedness) {
  const w = lms[0];
  const [i, m, r, p] = FINGERS.map(([tip, pip]) => d2(lms[tip], w) > d2(lms[pip], w));
  const gesture = i && p && !m && !r ? 'shoot'
    : !i && !m && !r && !p ? 'fist'
    : i && m && r && p ? 'open' : 'none';
  const [hi, mid] = CFG.handLevelCuts;
  return { gesture, side: w.x < 0.5 ? 'L' : 'R', level: w.y < hi ? 'hi' : w.y < mid ? 'mid' : 'lo' };
}

// Returns the last gesture seen `frames` times in a row ('none' until then).
export function createGestureGate(frames) {
  let stable = 'none', cand = null, n = 0;
  return (g) => {
    if (g === cand) n++; else { cand = g; n = 1; }
    if (n >= frames) stable = g;
    return stable;
  };
}

// Drives the shared charge tracker from per-frame hand results. update(hands, t):
// hands = [{landmarks (mirrored), handedness}], t in seconds. The charge gesture is opts.mode.
// Hands are matched to the previous frame's by wrist distance. With two hands, the one that entered
// the charge gesture most recently owns the aim (like the keyboard's last-pressed key); the other's
// release fires nothing.
export function createHandController(tracker, { mode = 'shoot', onRelease = () => {} } = {}) {
  let slots = []; // {wrist, gate, stable, cur: classification, seen}
  let active = null;
  return { update(hands, t) {
    const cls = hands.map((h) => ({ ...classifyHand(h.landmarks, h.handedness), wrist: h.landmarks[0] }));
    const pairs = [];
    cls.forEach((c, i) => slots.forEach((s, j) => pairs.push([d2(c.wrist, s.wrist), i, j])));
    pairs.sort((a, b) => a[0] - b[0]);
    const match = new Map(), used = new Set();
    for (const [, i, j] of pairs) if (!match.has(i) && !used.has(j)) { match.set(i, slots[j]); used.add(j); }
    cls.forEach((c, i) => {
      let s = match.get(i);
      if (!s) slots.push(s = { gate: createGestureGate(CFG.handStableFrames), stable: 'none' });
      const prev = s.stable;
      s.stable = s.gate(c.gesture);
      s.wrist = c.wrist; s.cur = c; s.seen = t;
      if (s.stable === mode && prev !== mode) { tracker.press(c.side, c.level, t); active = s; }
      else if (s === active && s.stable === mode) { if (c.gesture === mode) tracker.move(c.side, c.level); }
      else if (s === active) {
        active = null;
        const shot = tracker.release(null, null, t);
        if (shot) onRelease(shot);
      }
    });
    slots = slots.filter((s) => {
      if (t - s.seen <= CFG.handLostMs / 1000) return true; // ms -> s
      if (s === active) { active = null; tracker.cancel(); }
      return false;
    });
    const shown = active || slots[0];
    return {
      hands: hands.length,
      gesture: shown ? shown.stable : 'none',
      side: shown ? shown.cur.side : null,
      level: shown ? shown.cur.level : null,
      open: slots.some((s) => s.stable === 'open'),
    };
  } };
}
