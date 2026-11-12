// Pure hand-gesture logic. No window/document: runs in Node tests.
// Coordinates: normalised [0,1], y down, in MIRRORED screen space (what the user sees in the preview).
// MediaPipe gives camera space, so pass its landmarks through mirror() first: raw x > 0.5 => screen half 'L'.
import { CFG } from './config.js';

const FINGERS = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]]; // MediaPipe [mcp, pip, tip]: index, middle, ring, pinky
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const sub = (a, b) => [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)];

export const mirror = (lms) => lms.map((p) => ({ ...p, x: 1 - p.x }));

// Bend of each finger in degrees: angle between MCP->PIP and PIP->TIP in 3D. 0 = straight,
// ~130 = folded onto the palm. Unlike distance-from-wrist it does not care whether the palm or
// the back faces the camera, how the hand is tilted, or how big it is. Pass world landmarks if you have them.
export function fingerBends(lms) {
  return FINGERS.map(([m, p, t]) => {
    const u = sub(lms[p], lms[m]), v = sub(lms[t], lms[p]);
    const n = Math.hypot(...u) * Math.hypot(...v);
    return n ? Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / n))) * 180 / Math.PI : 0;
  });
}

// Thumb is don't-care. 'open' needs all four fingers straight (< handStraightDeg); 'shoot' needs index and
// pinky out (< handExtendDeg) and middle and ring merely bent (> handCurlDeg), so a lazy thwip still counts.
// The two never overlap (middle/ring below 30 vs above 40). prev = last frame's gesture: its thresholds
// loosen by handHystDeg so a hand near a border does not flicker.
export function gestureFromBends([i, m, r, p], prev = 'none') {
  const { handStraightDeg: S, handExtendDeg: E, handCurlDeg: C, handFistDeg: F, handHystDeg: H } = CFG;
  const h = (g) => (prev === g ? H : 0);
  if (i < E + h('shoot') && p < E + h('shoot') && m > C - h('shoot') && r > C - h('shoot')) return 'shoot';
  if (Math.min(i, m, r, p) > F - h('fist')) return 'fist';
  if (Math.max(i, m, r, p) < S + h('open')) return 'open';
  return 'none';
}

// side = the half of the MIRRORED preview the wrist is in (what the user sees: hand on the left = 'L'),
// level = the wrist's height in that same preview. handedness is accepted but only informational.
// opts.world: world landmarks for the bend angles (metric 3D, no aspect distortion); opts.prev: see gestureFromBends.
// Palm centre, not the wrist: the wrist sits well below the hand, so with wrist height the top third was
// nearly unreachable and the zones did not match where the user sees the hand in the preview.
export const palmCenter = (lms) => {
  const ids = [0, 5, 9, 13, 17];
  return { x: ids.reduce((a, i) => a + lms[i].x, 0) / 5, y: ids.reduce((a, i) => a + lms[i].y, 0) / 5 };
};

export function classifyHand(lms, handedness, { world, prev } = {}) {
  const c = palmCenter(lms);
  const bends = fingerBends(world ?? lms);
  const gesture = gestureFromBends(bends, prev);
  const [hi, mid] = CFG.handLevelCuts;
  return { gesture, bends, side: c.x < 0.5 ? 'L' : 'R', level: c.y < hi ? 'hi' : c.y < mid ? 'mid' : 'lo' };
}

// While a web is held, only a clear break of the pose lets go: index or pinky folds well past the shoot limit,
// or the hand opens flat. A tilted or half-turned hand that reads 'none' keeps the rope (it used to drop it).
export function stillHolding([i, m, r, p]) {
  const lim = CFG.handExtendDeg + CFG.handHoldSlackDeg;
  const open = m < CFG.handStraightDeg && r < CFG.handStraightDeg;
  return i < lim && p < lim && !open;
}

// Apparent hand size in the image: wrist -> middle-finger MCP. Pulling the hand toward the body shrinks it.
export const handSize = (lms) => Math.sqrt(d2(lms[0], lms[9]));

const GESTURE_KO = { shoot: '발사', fist: '주먹', open: '손바닥', none: '없음' };
const LEVEL_KO = { hi: '위', mid: '가운데', lo: '아래' };
// Status line text for the HUD: st = createHandController status (or null).
export const handStatusText = (st) => !st || !st.hands ? '손 없음'
  : `${GESTURE_KO[st.gesture] ?? '없음'} · ${st.side === 'L' ? '왼' : '오'} · ${LEVEL_KO[st.level] ?? '가운데'}${st.zip ? ' · 당기기!' : ''}`;

// Returns the last gesture seen `frames` times in a row ('none' until then).
export function createGestureGate(frames) {
  let stable = 'none', cand = null, n = 0;
  return (g) => {
    if (g === cand) n++; else { cand = g; n = 1; }
    if (n >= frames) stable = g;
    return stable;
  };
}

// Drives the shared aim tracker from per-frame hand results. update(hands, t):
// hands = [{landmarks (mirrored), world?, handedness?}], t in seconds. The hold gesture is opts.mode.
// opts.onShot gets the keyboard's actions: {type:'press', side, level} when a hand enters the gesture,
// {type:'release', ...} when the aiming hand leaves it or is lost (lets go of the rope).
// Hands are matched to the previous frame's by wrist distance (up to CFG.handMatchMaxDist; farther is
// a new hand). With two hands, the one that entered the charge gesture most recently owns the aim
// (like the keyboard's last-pressed key); the other's release does nothing.
// Charging is judged on the RAW gesture: CFG.handStableFrames charge frames in a row press,
// CFG.handReleaseFrames non-charge frames in a row release, so a flickering none/open cannot hold the release back.
// The status gesture is the mode exactly while charging, so the HUD never shows it without a press sent.
// If someone else clears the tracker while a hand still charges (the game calls tracker.cancel() on start and
// on death, and drops presses outside play), the press is sent again: a gesture held through the start fires.
// update([], t) with no detection only ages hands out, so it can run on frames without a new image.
// Zip: while the aiming hand holds the gesture, its apparent size (handSize) dropping by CFG.handZipShrink within
// CFG.handZipWindowMs (the hand pulled toward the body) sends {type:'zip'} once, then waits CFG.handZipCooldownMs.
// Size, not wrist motion: it is scale-free and independent of where the hand is, while a downward wrist move
// would fight the level (wrist height) the user aims with. status.zip is true during the cooldown (HUD 당기기!).
export function createHandController(tracker, { mode = 'shoot', onShot = () => {} } = {}) {
  let slots = []; // {wrist, gate, stable, cur: classification, prev, seen, charging, on, run}
  let active = null, zipAt = -Infinity;
  const press = (s, t) => {
    tracker.press(s.cur.side, s.cur.level, t);
    active = s;
    s.sizes = [];
    onShot({ type: 'press', side: s.cur.side, level: s.cur.level });
  };
  return { update(hands, t) {
    const pairs = [];
    hands.forEach((h, i) => slots.forEach((s, j) => pairs.push([d2(h.landmarks[0], s.wrist), i, j])));
    pairs.sort((a, b) => a[0] - b[0]);
    const match = new Map(), used = new Set();
    for (const [dd, i, j] of pairs) {
      if (dd > CFG.handMatchMaxDist ** 2) break;
      if (!match.has(i) && !used.has(j)) { match.set(i, slots[j]); used.add(j); }
    }
    hands.forEach((h, i) => {
      let s = match.get(i);
      if (!s) slots.push(s = { gate: createGestureGate(CFG.handStableFrames), charging: false, on: false, run: 0, prev: 'none' });
      const c = classifyHand(h.landmarks, h.handedness, { world: h.world, prev: s.prev });
      s.prev = c.gesture;
      s.stable = s.gate(c.gesture);
      s.wrist = h.landmarks[0]; s.cur = c; s.seen = t;
      const on = s.charging && mode === 'shoot' ? stillHolding(c.bends) : c.gesture === mode;
      s.run = on === s.on ? s.run + 1 : 1;
      s.on = on;
      if (on !== s.charging && s.run >= (on ? CFG.handStableFrames : CFG.handReleaseFrames)) {
        s.charging = on;
        if (on) press(s, t);
        else if (s === active) { active = null; onShot({ type: 'release', ...tracker.release(null, null, t) }); }
      }
      if (s === active && s.charging) {
        const size = handSize(h.landmarks), win = CFG.handZipWindowMs / 1000;
        s.sizes = s.sizes.filter((e) => t - e.t <= win);
        const peak = Math.max(size, ...s.sizes.map((e) => e.size));
        s.sizes.push({ t, size });
        if (size < peak * (1 - CFG.handZipShrink) && (t - zipAt) * 1000 >= CFG.handZipCooldownMs) {
          zipAt = t; s.sizes = [];
          onShot({ type: 'zip' });
        }
      }
    });
    slots = slots.filter((s) => {
      if (t - s.seen <= CFG.handLostMs / 1000) return true; // ms -> s
      if (s === active) { active = null; tracker.cancel(); onShot({ type: 'release' }); }
      return false;
    });
    if (active && !tracker.state(t)) press(active, t); // tracker cleared under a held gesture: press again
    const shown = active || slots[0];
    return {
      hands: slots.length,
      gesture: !shown ? 'none' : shown.charging ? mode : shown.stable === mode ? 'none' : shown.stable,
      side: shown ? shown.cur.side : null,
      level: shown ? shown.cur.level : null,
      open: slots.some((s) => s.stable === 'open'),
      zip: (t - zipAt) * 1000 < CFG.handZipCooldownMs,
    };
  } };
}
