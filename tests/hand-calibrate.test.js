import test from 'node:test';
import assert from 'node:assert/strict';
import { handFeatures, createClassifier, blendGesture, makeOverride, loadTemplates, saveTemplates, clearTemplates,
  createCalibrationSession, FEATURE_LEN, POSES } from '../src/hand-calibrate.js';
import { classifyHand, setGestureOverride } from '../src/hand-classify.js';
import { hand, NONE } from './hand-fixture.js';

const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
// This user's own poses: a lazy thwip with a half-bent index (the rules call it 'none'), thumb tucked;
// a slightly cupped open palm; a loose fist.
const BASE = {
  shoot: { i: 0.6, m: 0.85, r: 0.85, p: 0.15, thumb: 'in' },
  open: { i: 0.12, m: 0.12, r: 0.15, p: 0.18, thumb: 'out' },
  fist: { i: 0.95, m: 0.95, r: 0.9, p: 0.9, thumb: 'in' },
};
// rot/scale: how far the pose may be turned and resized; the held-out set uses more than calibration did
function sample(pose, r, rot, [s0, s1]) {
  const { thumb, ...c } = BASE[pose];
  const curl = Object.fromEntries(Object.entries(c).map(([f, v]) => [f, Math.max(0, Math.min(1, v + (r() - 0.5) * 0.12))]));
  const j = () => (r() - 0.5) * 2 * rot;
  return hand(0.3 + r() * 0.4, 0.4 + r() * 0.3, '', { curl, thumb, left: r() < 0.5, yaw: j(), pitch: j() * 0.6, roll: j(), scale: s0 + r() * (s1 - s0) });
}
const calibrate = (r) => Object.fromEntries(POSES.map((g) => [g, Array.from({ length: 60 }, () => handFeatures(sample(g, r, 15, [0.9, 1.1])))]));

test('handFeatures: 19 finite numbers, the same for a scaled and rotated copy except the palm normal', () => {
  const a = handFeatures(hand(0.5, 0.5, 'ip')), b = handFeatures(hand(0.4, 0.6, 'ip', { scale: 1.7, roll: 50, yaw: 30 }));
  assert.equal(a.length, FEATURE_LEN);
  assert.ok(a.every(Number.isFinite));
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `feature ${i}`);
});

test('calibrated k-NN: >= 95 % on held-out samples turned and resized beyond the calibration', () => {
  const r = rng(11), classify = createClassifier(calibrate(r));
  for (const g of POSES) {
    let ok = 0;
    for (let n = 0; n < 100; n++) {
      const res = classify(handFeatures(sample(g, r, 35, [0.6, 1.6])));
      if (res.gesture === g && !res.ood) ok++;
    }
    assert.ok(ok >= 95, `${g}: ${ok}/100`);
  }
});

test('calibration carries the user\'s lazy thwip the rules miss; an unseen pose falls back to the rules', () => {
  const r = rng(5), classify = createClassifier(calibrate(r));
  const lazy = sample('shoot', r, 10, [1, 1]);
  assert.equal(classifyHand(lazy).gesture, 'none', 'rules alone miss it');
  setGestureOverride(makeOverride(classify));
  try {
    assert.equal(classifyHand(lazy).gesture, 'shoot');
    const peace = hand(0.5, 0.5, NONE); // index + middle up: never calibrated
    const res = classify(handFeatures(peace));
    assert.ok(res.ood, `nearest ${res.dist}`);
    assert.equal(classifyHand(peace).gesture, 'none', 'the rules answer');
  } finally { setGestureOverride(null); }
  assert.equal(classifyHand(lazy).gesture, 'none', 'uncalibrated = rules again');
});

test('blendGesture: rules without calibration or out of distribution; split votes read none', () => {
  const p = (shoot, open, fist) => ({ probs: { shoot, open, fist }, ood: false });
  assert.equal(blendGesture('open', null), 'open');
  assert.equal(blendGesture('open', { ...p(1, 0, 0), ood: true }), 'open');
  assert.equal(blendGesture('none', p(1, 0, 0)), 'shoot');
  assert.equal(blendGesture('shoot', p(0.3, 0.7, 0)), 'none');
  assert.equal(blendGesture('shoot', p(0.5, 0.5, 0)), 'shoot');
});

test('templates round-trip through storage, thinned; junk reads as no calibration', () => {
  const mem = new Map(), storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  assert.equal(loadTemplates(storage), null);
  const t = calibrate(rng(3));
  t.open = [...t.open, ...t.open, ...t.open, ...t.open]; // 240
  const saved = saveTemplates(storage, t);
  assert.ok(saved.open.length <= 90 && saved.open.length >= 60);
  assert.deepEqual(loadTemplates(storage), saved);
  storage.setItem('webrunner.handCalib.v1', JSON.stringify({ ...saved, fist: [[1, 2]] }));
  assert.equal(loadTemplates(storage), null);
  storage.setItem('webrunner.handCalib.v1', '{oops');
  assert.equal(loadTemplates(storage), null);
  clearTemplates(storage);
  assert.equal(loadTemplates(null), null);
});

test('calibration session: wait -> prep -> rec per pose, restarts prep when the hand leaves, then done', () => {
  const s = createCalibrationSession({ prepSec: 1, recordSec: 2 });
  const h = [{ landmarks: hand(0.5, 0.5, 'ip') }, { landmarks: hand(0.3, 0.5, 'ip', { left: true }) }];
  let t = 0, st = s.update([], t);
  assert.equal(st.phase, 'wait');
  st = s.update(h, t += 0.5);
  assert.deepEqual([st.pose, st.phase], ['shoot', 'prep']);
  st = s.update([], t += 0.1);
  assert.equal(st.phase, 'wait', 'hand gone during prep');
  for (const pose of POSES) {
    while ((st = s.update(h, t += 1 / 30)).pose === pose && st.phase !== 'done');
  }
  assert.equal(st.phase, 'done');
  for (const g of POSES) assert.ok(s.templates[g].length >= 100, `${g} ${s.templates[g].length}`); // 2 hands x ~60 frames
});
