import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHand, createGestureGate, createHandController, mirror } from '../src/hand-classify.js';
import { createChargeTracker } from '../src/input-core.js';

// Synthetic hand: 21 points at the wrist; each finger's PIP 0.1 above it, tip 0.2 (extended) or 0.05 (folded).
const FINGERS = { i: [6, 8], m: [10, 12], r: [14, 16], p: [18, 20] };
function hand(wx, wy, ext) {
  const lm = Array.from({ length: 21 }, () => ({ x: wx, y: wy }));
  for (const [f, [pip, tip]] of Object.entries(FINGERS)) {
    lm[pip] = { x: wx, y: wy - 0.1 };
    lm[tip] = { x: wx, y: wy - (ext.includes(f) ? 0.2 : 0.05) };
  }
  return lm;
}
const SHOOT = 'ip', FIST = '', OPEN = 'imrp';

test('classifyHand gestures (thumb ignored)', () => {
  assert.equal(classifyHand(hand(0.5, 0.5, SHOOT), 'Right').gesture, 'shoot');
  assert.equal(classifyHand(hand(0.5, 0.5, FIST), 'Right').gesture, 'fist');
  assert.equal(classifyHand(hand(0.5, 0.5, OPEN), 'Left').gesture, 'open');
  assert.equal(classifyHand(hand(0.5, 0.5, 'im'), 'Left').gesture, 'none'); // peace sign
  assert.equal(classifyHand(hand(0.5, 0.5, 'i'), 'Left').gesture, 'none');
});

test('classifyHand side/level from wrist in mirrored screen space', () => {
  assert.deepEqual(classifyHand(hand(0.2, 0.1, SHOOT), 'Right'), { gesture: 'shoot', side: 'L', level: 'hi' });
  assert.deepEqual(classifyHand(hand(0.8, 0.9, FIST), 'Left'), { gesture: 'fist', side: 'R', level: 'lo' });
  assert.equal(classifyHand(hand(0.3, 0.5, FIST), 'Left').level, 'mid');
  // handedness is ignored: same position, other label, same side
  assert.equal(classifyHand(hand(0.2, 0.5, FIST), 'Left').side, 'L');
});

test('mirror: raw MediaPipe x > 0.5 is the left of the mirrored preview', () => {
  assert.equal(classifyHand(mirror(hand(0.8, 0.5, FIST)), 'Right').side, 'L');
  assert.equal(classifyHand(mirror(hand(0.2, 0.5, FIST)), 'Right').side, 'R');
});

test('gesture gate needs N consecutive frames', () => {
  const gate = createGestureGate(3);
  const out = ['shoot', 'shoot', 'none', 'shoot', 'shoot', 'shoot'].map(gate);
  assert.deepEqual(out, ['none', 'none', 'none', 'none', 'none', 'shoot']);
  assert.deepEqual(['fist', 'fist'].map(gate), ['shoot', 'shoot']); // keeps last stable value until confirmed
  assert.equal(gate('fist'), 'fist');
});

// Feeds one hand (or a list) for n frames, 1/30 s apart, starting at t0. Returns the next t.
const DT = 1 / 30;
function feed(ctrl, hands, n, t0) {
  let t = t0;
  for (let k = 0; k < n; k++, t += DT) ctrl.update(hands.map((landmarks) => ({ landmarks, handedness: 'Right' })), t);
  return t;
}

test('controller: charge gesture press, hold, release fires the shot', () => {
  const tr = createChargeTracker();
  const shots = [];
  const ctrl = createHandController(tr, { mode: 'shoot', onRelease: (s) => shots.push(s) });
  let t = feed(ctrl, [hand(0.8, 0.1, SHOOT)], 3, 0);
  assert.deepEqual({ ...tr.state(t), heldSec: 0 }, { side: 'R', level: 'hi', heldSec: 0 });
  t = feed(ctrl, [hand(0.8, 0.1, SHOOT)], 20, t);
  t = feed(ctrl, [hand(0.8, 0.1, OPEN)], 3, t);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].side, 'R'); assert.equal(shots[0].level, 'hi');
  assert.ok(shots[0].heldSec > 0.6 && shots[0].heldSec < 0.8, `${shots[0].heldSec}`);
  assert.equal(tr.state(t), null);
});

test('controller: moving during charge calls move; release uses last charge-pose position', () => {
  const tr = createChargeTracker();
  const shots = [];
  const ctrl = createHandController(tr, { onRelease: (s) => shots.push(s) });
  let t = feed(ctrl, [hand(0.8, 0.1, SHOOT)], 3, 0);
  t = feed(ctrl, [hand(0.2, 0.5, SHOOT)], 2, t);
  assert.deepEqual([tr.state(t).side, tr.state(t).level], ['L', 'mid']);
  // while the release is being confirmed the wrist drifts down; that must not change the aim
  feed(ctrl, [hand(0.2, 0.9, FIST)], 3, t);
  assert.deepEqual([shots[0].side, shots[0].level], ['L', 'mid']);
});

test('controller: hand lost longer than handLostMs cancels, short gap does not', () => {
  const tr = createChargeTracker();
  const shots = [];
  const ctrl = createHandController(tr, { onRelease: (s) => shots.push(s) });
  let t = feed(ctrl, [hand(0.5, 0.5, SHOOT)], 3, 0);
  t = feed(ctrl, [], 6, t); // 0.2 s gap
  assert.ok(tr.state(t), 'still charging after a short gap');
  t = feed(ctrl, [hand(0.5, 0.5, SHOOT)], 1, t);
  t = feed(ctrl, [], 12, t); // 0.4 s gap
  assert.equal(tr.state(t), null);
  feed(ctrl, [hand(0.5, 0.5, OPEN)], 3, t);
  assert.equal(shots.length, 0);
});

test('controller: two hands, the one that entered the charge most recently owns the aim', () => {
  const tr = createChargeTracker();
  const shots = [];
  const ctrl = createHandController(tr, { onRelease: (s) => shots.push(s) });
  const L = (ext) => hand(0.2, 0.5, ext), R = (ext) => hand(0.8, 0.9, ext);
  let t = feed(ctrl, [L(SHOOT), R(FIST)], 3, 0);
  assert.equal(tr.state(t).side, 'L');
  t = feed(ctrl, [R(SHOOT), L(SHOOT)], 3, t); // order swapped: matching is by position, not index
  assert.deepEqual([tr.state(t).side, tr.state(t).level], ['R', 'lo']);
  t = feed(ctrl, [L(OPEN), R(SHOOT)], 3, t); // the superseded hand letting go fires nothing
  assert.equal(shots.length, 0);
  feed(ctrl, [L(OPEN), R(OPEN)], 3, t);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].side, 'R');
});

test('controller: fist mode charges on fist, open releases; status reports open palm', () => {
  const tr = createChargeTracker();
  const shots = [];
  const ctrl = createHandController(tr, { mode: 'fist', onRelease: (s) => shots.push(s) });
  let t = feed(ctrl, [hand(0.5, 0.5, SHOOT)], 3, 0);
  assert.equal(tr.state(t), null);
  t = feed(ctrl, [hand(0.5, 0.5, FIST)], 3, t);
  assert.ok(tr.state(t));
  let st;
  for (let k = 0; k < 3; k++, t += DT) st = ctrl.update([{ landmarks: hand(0.5, 0.5, OPEN), handedness: 'Left' }], t);
  assert.equal(shots.length, 1);
  assert.deepEqual(st, { hands: 1, gesture: 'open', side: 'R', level: 'mid', open: true });
  assert.deepEqual(ctrl.update([], t), { hands: 0, gesture: 'open', side: 'R', level: 'mid', open: true });
});
