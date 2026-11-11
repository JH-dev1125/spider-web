import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHand, createGestureGate, createHandController, mirror } from '../src/hand-classify.js';
import { createChargeTracker } from '../src/input-core.js';
import { hand, SHOOT, FIST, OPEN, NONE } from './hand-fixture.js';

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
  let t = feed(ctrl, [hand(0.55, 0.3, SHOOT)], 3, 0);
  assert.deepEqual([tr.state(t).side, tr.state(t).level], ['R', 'hi']);
  t = feed(ctrl, [hand(0.45, 0.4, SHOOT)], 2, t);
  assert.deepEqual([tr.state(t).side, tr.state(t).level], ['L', 'mid']);
  // while the release is being confirmed the wrist drifts down into 'lo'; that must not change the aim
  for (const y of [0.5, 0.6, 0.7]) t = feed(ctrl, [hand(0.45, y, FIST)], 1, t);
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
  // hands counts tracked hands (seen within handLostMs), so frames without a detection don't flicker it to 0
  assert.deepEqual(ctrl.update([], t), { hands: 1, gesture: 'open', side: 'R', level: 'mid', open: true });
  assert.equal(ctrl.update([], t + 1).hands, 0);
});

test('controller: alternating none/open while letting go still releases after N raw non-charge frames', () => {
  const tr = createChargeTracker();
  const shots = [];
  const ctrl = createHandController(tr, { onRelease: (s) => shots.push(s) });
  let t = feed(ctrl, [hand(0.2, 0.1, SHOOT)], 3, 0);
  for (const ext of [NONE, OPEN]) t = feed(ctrl, [hand(0.2, 0.1, ext)], 1, t);
  assert.equal(shots.length, 0);
  t = feed(ctrl, [hand(0.2, 0.1, NONE)], 1, t); // third non-charge frame in a row
  assert.equal(shots.length, 1);
  assert.deepEqual([shots[0].side, shots[0].level], ['L', 'hi']);
  t = feed(ctrl, [hand(0.2, 0.1, SHOOT)], 3, t); // charging again presses again
  assert.ok(tr.state(t));
  for (const ext of [OPEN, NONE, OPEN]) t = feed(ctrl, [hand(0.2, 0.1, ext)], 1, t);
  assert.equal(shots.length, 2);
});

test('controller: a hand far away does not inherit the charge of one that just vanished', () => {
  const tr = createChargeTracker();
  const shots = [];
  const ctrl = createHandController(tr, { onRelease: (s) => shots.push(s) });
  let t = feed(ctrl, [hand(0.2, 0.5, SHOOT)], 3, 0);
  t = feed(ctrl, [hand(0.8, 0.5, OPEN)], 3, t); // appears the same frame the charging hand is gone
  assert.equal(shots.length, 0);
  t = feed(ctrl, [hand(0.8, 0.5, OPEN)], 10, t); // past handLostMs: the vanished hand's charge is cancelled
  assert.equal(tr.state(t), null);
  assert.equal(shots.length, 0);
  // a hand moving a normal amount between frames keeps its identity
  t = feed(ctrl, [hand(0.5, 0.5, SHOOT)], 3, t);
  t = feed(ctrl, [hand(0.55, 0.5, SHOOT)], 1, t);
  feed(ctrl, [hand(0.6, 0.5, OPEN)], 3, t);
  assert.equal(shots.length, 1);
});

import { handStatusText } from '../src/hand-classify.js';
test('handStatusText: Korean labels', () => {
  assert.equal(handStatusText(null), '손 없음');
  assert.equal(handStatusText({ hands: 1, gesture: 'shoot', side: 'L', level: 'hi' }), '발사 · 왼 · 위');
  assert.equal(handStatusText({ hands: 1, gesture: 'open', side: 'R', level: 'lo' }), '손바닥 · 오 · 아래');
});
