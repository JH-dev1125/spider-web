// Personal hand-pose calibration. Pure: no window/document; storage is passed in (localStorage-like).
// The user holds each pose for a couple of seconds; each frame becomes a feature vector (template).
// Live frames are classified by distance-weighted k-NN over those templates and blended with the angle rules.
import { fingerBends } from './hand-classify.js';

export const POSES = ['shoot', 'open', 'fist'];
const TIPS = [4, 8, 12, 16, 20];
const NORMAL_W = 0.3; // palm normal changes with how the hand is turned: let it nudge, not decide
const v3 = (a, b) => [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)];
const len = (v) => Math.hypot(...v);
const angle = (u, v) => { const n = len(u) * len(v); return n ? Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / n))) : 0; };

// 19 numbers, scale- and (except the normal) rotation-free. pts: 21 landmarks, world landmarks preferred.
// [4 finger bends + thumb bend] / 90 deg, 10 fingertip-to-fingertip distances + thumb tip to index MCP,
// each over palm size (wrist -> middle MCP), then the palm normal (wrist->index MCP x wrist->pinky MCP).
export function handFeatures(pts) {
  const palm = len(v3(pts[9], pts[0])) || 1;
  const bends = [...fingerBends(pts), angle(v3(pts[3], pts[2]), v3(pts[4], pts[3])) * 180 / Math.PI].map((d) => d / 90);
  const dists = [];
  for (let a = 0; a < TIPS.length; a++) for (let b = a + 1; b < TIPS.length; b++) dists.push(len(v3(pts[TIPS[a]], pts[TIPS[b]])) / palm);
  dists.push(len(v3(pts[4], pts[5])) / palm);
  const u = v3(pts[5], pts[0]), w = v3(pts[17], pts[0]);
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const nl = len(n) || 1;
  return [...bends, ...dists, ...n.map((c) => c / nl * NORMAL_W)];
}
export const FEATURE_LEN = 19;

const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); };

// templates: {shoot: [features...], open: [...], fist: [...]}. Returns classify(features) ->
// {gesture, probs {pose: 0..1}, dist (to the nearest template), ood}. ood = farther from every template than
// the templates usually are from each other (3x the median leave-one-out nearest distance): a pose the user
// never showed, so the caller should trust the rules instead.
export function createClassifier(templates, k = 7) {
  const all = POSES.flatMap((g) => (templates[g] ?? []).map((f) => ({ g, f })));
  const loo = all.map((a) => Math.min(...all.filter((b) => b !== a).map((b) => dist(a.f, b.f)))).sort((a, b) => a - b);
  const reject = Math.max(0.25, 3 * (loo[loo.length >> 1] ?? 0));
  return (f) => {
    const near = all.map((a) => ({ g: a.g, d: dist(a.f, f) })).sort((a, b) => a.d - b.d).slice(0, k);
    const probs = Object.fromEntries(POSES.map((g) => [g, 0]));
    let total = 0;
    for (const { g, d } of near) { const wt = 1 / (d + 0.02); probs[g] += wt; total += wt; }
    for (const g of POSES) probs[g] /= total;
    const gesture = POSES.reduce((a, b) => (probs[b] > probs[a] ? b : a));
    return { gesture, probs, dist: near[0].d, ood: near[0].d > reject };
  };
}

// Calibrated vote 0.65, rule vote 0.35; the winner needs 0.6, so the user's own templates alone can
// carry a pose the rules call 'none', and a disagreement with a split k-NN vote reads 'none'.
export function blendGesture(rule, res) {
  if (!res || res.ood) return rule;
  let best = 'none', top = 0;
  for (const g of POSES) {
    const s = 0.65 * res.probs[g] + (rule === g ? 0.35 : 0);
    if (s > top) { top = s; best = g; }
  }
  return top >= 0.6 ? best : 'none';
}

// The hook classifyHand takes (setGestureOverride in hand-classify.js): (points, ruleGesture) -> gesture.
export const makeOverride = (classify) => (pts, rule) => blendGesture(rule, classify(handFeatures(pts)));

const KEY = 'webrunner.handCalib.v1';
const MAX_PER_POSE = 90;
const MIN_PER_POSE = 10;
// localStorage is user-editable: anything not shaped like our templates reads as "no calibration".
export function loadTemplates(storage) {
  try {
    const t = JSON.parse(storage?.getItem(KEY) ?? 'null');
    const ok = t && POSES.every((g) => Array.isArray(t[g]) && t[g].length >= MIN_PER_POSE
      && t[g].every((f) => Array.isArray(f) && f.length === FEATURE_LEN && f.every(Number.isFinite)));
    return ok ? t : null;
  } catch { return null; }
}
export function saveTemplates(storage, t) {
  const thin = (a) => a.filter((_, i) => i % Math.ceil(a.length / MAX_PER_POSE) === 0);
  const out = Object.fromEntries(POSES.map((g) => [g, thin(t[g])]));
  try { storage?.setItem(KEY, JSON.stringify(out)); } catch { /* full or blocked: calibration lasts this session */ }
  return out;
}
export const clearTemplates = (storage) => { try { storage?.removeItem(KEY); } catch { /* blocked */ } };

// The calibration screen's state machine. update(hands, t) with the frame's hands ([{landmarks, world?}],
// t in seconds) returns {pose, index, phase, progress, samples}:
// 'wait' (no hand yet) -> 'prep' (prepSec with a hand up, to settle into the pose) -> 'rec' (recordSec,
// every visible hand's features are kept) -> the next pose; 'done' after the last, with templates.
// Losing every hand during prep goes back to wait; a recording with too few samples starts over.
export function createCalibrationSession({ prepSec = 1, recordSec = 2 } = {}) {
  let index = 0, phase = 'wait', since = 0, cur = [];
  const templates = Object.fromEntries(POSES.map((g) => [g, []]));
  return { templates, update(hands, t) {
    if (phase === 'done') return { pose: null, index, phase, progress: 1, samples: 0 };
    const seen = hands.length > 0;
    if (phase === 'wait' && seen) { phase = 'prep'; since = t; }
    else if (phase === 'prep' && !seen) phase = 'wait';
    else if (phase === 'prep' && t - since >= prepSec) { phase = 'rec'; since = t; cur = []; }
    if (phase === 'rec') {
      for (const h of hands) cur.push(handFeatures(h.world ?? h.landmarks));
      if (t - since >= recordSec) {
        if (cur.length < MIN_PER_POSE) { since = t; cur = []; } else {
          templates[POSES[index]] = cur;
          index++;
          phase = index < POSES.length ? 'wait' : 'done';
        }
      }
    }
    const dur = phase === 'prep' ? prepSec : phase === 'rec' ? recordSec : 1;
    return { pose: POSES[index] ?? null, index, phase, progress: phase === 'done' ? 1 : phase === 'wait' ? 0 : Math.min(1, (t - since) / dur), samples: cur.length };
  } };
}
