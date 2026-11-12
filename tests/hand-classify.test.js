import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHand, createGestureGate, createHandController, mirror, fingerBends, gestureFromBends } from '../src/hand-classify.js';
import { CFG } from '../src/config.js';
import { createChargeTracker } from '../src/input-core.js';
import { hand, SHOOT, FIST, OPEN, NONE } from './hand-fixture.js';

test('classifyHand gestures (thumb ignored)', () => {
  assert.equal(classifyHand(hand(0.5, 0.5, SHOOT), 'Right').gesture, 'shoot');
  assert.equal(classifyHand(hand(0.5, 0.5, FIST), 'Right').gesture, 'fist');
  assert.equal(classifyHand(hand(0.5, 0.5, OPEN), 'Left').gesture, 'open');
  assert.equal(classifyHand(hand(0.5, 0.5, 'im'), 'Left').gesture, 'none'); // peace sign
  assert.equal(classifyHand(hand(0.5, 0.5, 'i'), 'Left').gesture, 'none');
});

const pick = ({ gesture, side, level }) => ({ gesture, side, level });
test('classifyHand side/level from the palm in mirrored screen space', () => {
  assert.deepEqual(pick(classifyHand(hand(0.2, 0.1, SHOOT), 'Right')), { gesture: 'shoot', side: 'L', level: 'hi' });
  assert.deepEqual(pick(classifyHand(hand(0.8, 0.9, FIST), 'Left')), { gesture: 'fist', side: 'R', level: 'lo' });
  assert.equal(classifyHand(hand(0.3, 0.5, FIST), 'Left').level, 'mid');
  // a bare label (no score) is not trusted: same position, other label, same side
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

test('controller: entering the gesture presses at once, leaving it releases', () => {
  const tr = createChargeTracker();
  const shots = [], presses = [];
  const ctrl = createHandController(tr, { mode: 'shoot', onShot: (s) => { if (s.type === 'release') shots.push(s); else presses.push(s); } });
  let t = feed(ctrl, [hand(0.8, 0.1, SHOOT)], 3, 0);
  assert.deepEqual(presses, [{ type: 'press', side: 'R', level: 'hi' }]);
  assert.deepEqual({ ...tr.state(t), heldSec: 0 }, { side: 'R', level: 'hi', heldSec: 0 });
  t = feed(ctrl, [hand(0.8, 0.1, SHOOT)], 20, t);
  t = feed(ctrl, [hand(0.8, 0.1, OPEN)], 3, t);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].side, 'R'); assert.equal(shots[0].level, 'hi');
  assert.ok(shots[0].heldSec > 0.6 && shots[0].heldSec < 0.8, `${shots[0].heldSec}`);
  assert.equal(tr.state(t), null);
});

test('controller: moving while holding does not re-aim (the web is already attached)', () => {
  const tr = createChargeTracker();
  const shots = [], presses = [];
  const ctrl = createHandController(tr, { onShot: (s) => { if (s.type === 'release') shots.push(s); else presses.push(s); } });
  let t = feed(ctrl, [hand(0.55, 0.3, SHOOT)], 3, 0);
  assert.deepEqual([tr.state(t).side, tr.state(t).level], ['R', 'hi']);
  t = feed(ctrl, [hand(0.45, 0.4, SHOOT)], 2, t);
  assert.deepEqual([tr.state(t).side, tr.state(t).level], ['R', 'hi']);
  assert.equal(presses.length, 1);
  for (const y of [0.5, 0.6, 0.7]) t = feed(ctrl, [hand(0.45, y, FIST)], 1, t);
  assert.deepEqual([shots[0].type, shots[0].side, shots[0].level], ['release', 'R', 'hi']);
});

test('controller: hand lost longer than handLostMs releases, short gap does not', () => {
  const tr = createChargeTracker();
  const shots = [], presses = [];
  const ctrl = createHandController(tr, { onShot: (s) => { if (s.type === 'release') shots.push(s); else presses.push(s); } });
  let t = feed(ctrl, [hand(0.5, 0.5, SHOOT)], 3, 0);
  t = feed(ctrl, [], 6, t); // 0.2 s gap
  assert.ok(tr.state(t), 'still charging after a short gap');
  t = feed(ctrl, [hand(0.5, 0.5, SHOOT)], 1, t);
  assert.equal(shots.length, 0);
  t = feed(ctrl, [], 12, t); // 0.4 s gap
  assert.equal(tr.state(t), null);
  assert.deepEqual(shots, [{ type: 'release' }]); // the rope does not stay stuck
  feed(ctrl, [hand(0.5, 0.5, OPEN)], 3, t);
  assert.equal(shots.length, 1);
});

test('controller: two hands, the one that entered the charge most recently owns the aim', () => {
  const tr = createChargeTracker();
  const shots = [], presses = [];
  const ctrl = createHandController(tr, { onShot: (s) => { if (s.type === 'release') shots.push(s); else presses.push(s); } });
  const L = (ext) => hand(0.2, 0.5, ext), R = (ext) => hand(0.8, 0.9, ext);
  let t = feed(ctrl, [L(SHOOT), R(FIST)], 3, 0);
  assert.equal(tr.state(t).side, 'L');
  t = feed(ctrl, [R(SHOOT), L(SHOOT)], 3, t); // order swapped: matching is by position, not index
  assert.deepEqual([tr.state(t).side, tr.state(t).level], ['R', 'lo']);
  t = feed(ctrl, [L(OPEN), R(SHOOT)], 3, t); // the superseded hand letting go does nothing
  assert.equal(shots.length, 0);
  feed(ctrl, [L(OPEN), R(OPEN)], 3, t);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].side, 'R');
});

test('controller: fist mode charges on fist, open releases; status reports open palm', () => {
  const tr = createChargeTracker();
  const shots = [], presses = [];
  const ctrl = createHandController(tr, { mode: 'fist', onShot: (s) => { if (s.type === 'release') shots.push(s); else presses.push(s); } });
  let t = feed(ctrl, [hand(0.5, 0.5, SHOOT)], 3, 0);
  assert.equal(tr.state(t), null);
  t = feed(ctrl, [hand(0.5, 0.5, FIST)], 3, t);
  assert.ok(tr.state(t));
  let st;
  for (let k = 0; k < 3; k++, t += DT) st = ctrl.update([{ landmarks: hand(0.5, 0.5, OPEN), handedness: 'Left' }], t);
  assert.equal(shots.length, 1);
  assert.deepEqual(st, { hands: 1, gesture: 'open', side: 'R', level: 'mid', open: true, zip: false });
  // hands counts tracked hands (seen within handLostMs), so frames without a detection don't flicker it to 0
  assert.deepEqual(ctrl.update([], t), { hands: 1, gesture: 'open', side: 'R', level: 'mid', open: true, zip: false });
  assert.equal(ctrl.update([], t + 1).hands, 0);
});

test('controller: alternating none/open while letting go still releases after N raw non-charge frames', () => {
  const tr = createChargeTracker();
  const shots = [], presses = [];
  const ctrl = createHandController(tr, { onShot: (s) => { if (s.type === 'release') shots.push(s); else presses.push(s); } });
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

test('controller: a hand far away does not inherit the hold of one that just vanished', () => {
  const tr = createChargeTracker();
  const shots = [], presses = [];
  const ctrl = createHandController(tr, { onShot: (s) => { if (s.type === 'release') shots.push(s); else presses.push(s); } });
  let t = feed(ctrl, [hand(0.2, 0.5, SHOOT)], 3, 0);
  t = feed(ctrl, [hand(0.8, 0.5, OPEN)], 3, t); // appears the same frame the charging hand is gone
  assert.equal(shots.length, 0);
  t = feed(ctrl, [hand(0.8, 0.5, OPEN)], 10, t); // past handLostMs: the vanished hand's rope is released
  assert.equal(tr.state(t), null);
  assert.deepEqual(shots, [{ type: 'release' }]);
  // a hand moving a normal amount between frames keeps its identity
  t = feed(ctrl, [hand(0.5, 0.5, SHOOT)], 3, t);
  t = feed(ctrl, [hand(0.55, 0.5, SHOOT)], 1, t);
  feed(ctrl, [hand(0.6, 0.5, OPEN)], 3, t);
  assert.equal(shots.length, 2);
});

import { handStatusText } from '../src/hand-classify.js';
test('handStatusText: Korean labels', () => {
  assert.equal(handStatusText(null), '손 없음');
  assert.equal(handStatusText({ hands: 1, gesture: 'shoot', side: 'L', level: 'hi' }), '발사 · 왼 · 위');
  assert.equal(handStatusText({ hands: 1, gesture: 'open', side: 'R', level: 'lo' }), '손바닥 · 오 · 아래');
});

// Realistic poses: the canonical hand rotated, flipped, scaled and depth-squashed. Joint angles in 3D
// do not change under any of these, so every pose must read the same.
const POSES = {
  'palm to camera': {},
  'back to camera': { yaw: 180 },
  'yaw 40': { yaw: 40 },
  'yaw -45': { yaw: -45 },
  'pitch 35 (fingers toward camera)': { pitch: 35 },
  'pitch -30': { pitch: -30 },
  'roll 45': { roll: 45 },
  'tilted 30/30/30': { yaw: 30, pitch: 30, roll: 30 },
  'small (far)': { scale: 0.5 },
  'large (near)': { scale: 1.6 },
  'depth squashed x0.4': { zScale: 0.4, yaw: 35 },
  'thumb tucked': { thumb: 'in' },
};
for (const left of [false, true]) {
  for (const [name, pose] of Object.entries(POSES)) {
    test(`classifyHand ${left ? 'left' : 'right'} hand, ${name}`, () => {
      const at = (ext, o = {}) => classifyHand(hand(0.5, 0.5, ext, { ...pose, left, ...o }), null).gesture;
      assert.equal(at(SHOOT), 'shoot');
      assert.equal(at(SHOOT, { curl: { m: 0.45, r: 0.45 } }), 'shoot', 'thwip with middle/ring only half bent');
      assert.equal(at(SHOOT, { thumb: 'in' }), 'shoot', 'thumb is don\'t-care');
      assert.equal(at(OPEN), 'open');
      assert.equal(at(FIST), 'fist');
      assert.equal(at(NONE), 'none');
      assert.equal(at('i'), 'none');
      assert.equal(at('imp'), 'none', 'ring alone folded is not shoot');
    });
  }
}

test('fingerBends: straight ~0, folded onto the palm >100, same for the mirror image', () => {
  const b = fingerBends(hand(0.5, 0.5, SHOOT));
  assert.ok(b[0] < 15 && b[3] < 15 && b[1] > 100 && b[2] > 100, `${b}`);
  assert.deepEqual(fingerBends(hand(0.5, 0.5, SHOOT, { left: true })).map(Math.round), b.map(Math.round));
});

test('gestureFromBends: open and shoot are disjoint, hysteresis keeps the held gesture', () => {
  assert.equal(gestureFromBends([10, 35, 35, 10]), 'none'); // between open and shoot
  assert.equal(gestureFromBends([10, 35, 35, 10], 'shoot'), 'shoot'); // already shooting: stays
  assert.equal(gestureFromBends([10, 25, 25, 10], 'shoot'), 'open'); // clearly straight: leaves
  assert.equal(gestureFromBends([65, 120, 120, 10]), 'none');
  assert.equal(gestureFromBends([65, 120, 120, 10], 'shoot'), 'shoot');
  assert.equal(gestureFromBends([33, 33, 33, 33]), 'none');
  assert.equal(gestureFromBends([33, 33, 33, 33], 'open'), 'open');
});

// The side is where the user sees the hand in the mirrored preview, whichever hand it is and whatever MediaPipe says.
test('side = half of the mirrored preview: x 0.2 -> L, x 0.8 -> R, for either hand and any label', () => {
  for (const label of [null, 'Left', 'Right', { categoryName: 'Left', score: 0.99 }, { categoryName: 'Right', score: 0.99 }]) {
    for (const left of [false, true]) {
      assert.equal(classifyHand(hand(0.2, 0.5, SHOOT, { left }), label).side, 'L');
      assert.equal(classifyHand(hand(0.8, 0.5, SHOOT, { left }), label).side, 'R');
    }
  }
  // raw camera frame -> mirror() -> preview: a raw x of 0.8 is shown (scaleX(-1)) at 0.2, the left
  assert.equal(classifyHand(mirror(hand(0.8, 0.5, SHOOT)), 'Right').side, 'L');
  // the controller's press and the HUD status use the same side
  const ctrl = createHandController(createChargeTracker(), { onShot: (a) => log.push(a) }), log = [];
  let st;
  for (let k = 0; k < 2; k++) st = ctrl.update([{ landmarks: hand(0.2, 0.8, SHOOT, { left: true }), handedness: { categoryName: 'Left', score: 0.99 } }], k * DT);
  assert.deepEqual(log, [{ type: 'press', side: 'L', level: 'lo' }]);
  assert.equal(st.side, 'L');
});

// Zip: the aiming hand, still in the shoot pose, shrinks quickly in the image (pulled toward the body).
const pull = (scales, opts = {}) => {
  const log = [], sts = [];
  const ctrl = createHandController(createChargeTracker(), { onShot: (a) => log.push(a) });
  scales.forEach((scale, k) => sts.push(ctrl.update([{ landmarks: hand(0.7, 0.5, opts.ext ?? SHOOT, { scale }) }], k * DT)));
  return { zips: log.filter((a) => a.type === 'zip').length, log, sts };
};
test('hand zip: a quick shrink while holding the shoot pose zips once, shows 당기기!, then cools down', () => {
  const quick = pull([1, 1, 1, 1, 0.92, 0.84, 0.76, 0.72, 0.72, 0.72]); // -28% in 3 frames (0.1 s)
  assert.equal(quick.zips, 1);
  assert.ok(quick.log.findIndex((a) => a.type === 'zip') > quick.log.findIndex((a) => a.type === 'press'));
  assert.ok(quick.sts.at(-1).zip);
  assert.match(handStatusText(quick.sts.at(-1)), /당기기!/);
  // a slow drift toward the body (same 28% over 1 s) is not a pull
  assert.equal(pull([1, 1, ...Array.from({ length: 30 }, (_, k) => 1 - 0.28 * (k + 1) / 30)]).zips, 0);
  // small jitter is not a pull
  assert.equal(pull([1, 1, 0.95, 1, 0.94, 1, 0.96, 1, 0.95]).zips, 0);
  // not in the shoot pose (no rope held): nothing
  assert.equal(pull([1, 1, 1, 0.8, 0.7, 0.6], { ext: OPEN }).zips, 0);
  // pull, pull again within the cooldown: one zip; after the cooldown: a second
  const n = Math.ceil(CFG.handZipCooldownMs / 1000 / DT);
  assert.equal(pull([1, 1, 1, 0.7, 1, 1, 0.7]).zips, 1);
  assert.equal(pull([1, 1, 1, 0.7, ...Array(n).fill(1), 0.7]).zips, 2);
  assert.ok(!pull([1, 1, 1, 0.7, ...Array(n + 1).fill(1)]).sts.at(-1).zip, 'HUD clears after the cooldown');
});

// Both hands, mirrored positions and labels: identical timing, opposite sides.
for (const [label, x, side] of [['Right', 0.3, 'L'], ['Left', 0.7, 'R']]) {
  test(`controller symmetric: user's ${side === 'L' ? 'left' : 'right'} hand presses on frame 2, releases on frame 3`, () => {
    const tr = createChargeTracker();
    const log = [];
    const ctrl = createHandController(tr, { onShot: (s) => log.push(s) });
    const h = (ext) => [{ landmarks: hand(x, 0.2, ext, { left: side === 'L', yaw: 30 }), handedness: { categoryName: label, score: 0.9 } }];
    let t = 0;
    ctrl.update(h(SHOOT), t += DT);
    assert.equal(log.length, 0);
    ctrl.update(h(SHOOT), t += DT);
    assert.deepEqual(log, [{ type: 'press', side, level: 'hi' }]);
    ctrl.update(h(OPEN), t += DT); ctrl.update(h(OPEN), t += DT);
    assert.equal(log.length, 1);
    ctrl.update(h(OPEN), t += DT);
    assert.equal(log[1].type, 'release');
    assert.equal(log[1].side, side);
  });
}

test('controller: two hands with the same label fall back to screen halves', () => {
  const tr = createChargeTracker();
  const log = [];
  const ctrl = createHandController(tr, { onShot: (s) => log.push(s) });
  const same = { categoryName: 'Left', score: 0.99 };
  for (let k = 0; k < 2; k++) ctrl.update([
    { landmarks: hand(0.2, 0.5, SHOOT, { left: true }), handedness: same },
    { landmarks: hand(0.8, 0.5, FIST), handedness: same },
  ], k * DT);
  assert.equal(log[0].side, 'L');
});

// "The HUD shows 발사 but no web fires": the game drops presses outside play and clears the tracker on
// start, so a gesture made on the title (or held through death) never reached the game; and the HUD's
// sticky gate could keep showing 발사 after the controller had released. Invariant: whenever the status
// says 'shoot', the game (onShot while playing) has received a press since the gesture started.
test('controller: HUD shoot implies a press reached the game, even across start and death', () => {
  const tr = createChargeTracker();
  let playing = false, got = [];
  const ctrl = createHandController(tr, { onShot: (a) => { if (playing) got.push(a); } }); // main.js gate
  const step = (ext, t) => ctrl.update([{ landmarks: hand(0.7, 0.5, ext), handedness: 'Right' }], t);
  let t = 0;
  step(SHOOT, t += DT);
  for (let k = 0; k < 4; k++) assert.equal(step(SHOOT, t += DT).gesture, 'shoot'); // on the title
  playing = true; tr.cancel(); // main.js start()
  assert.equal(step(SHOOT, t += DT).gesture, 'shoot');
  assert.deepEqual(got, [{ type: 'press', side: 'R', level: 'mid' }]);
  playing = false; tr.cancel(); // death
  step(SHOOT, t += DT);
  playing = true; tr.cancel(); got = []; // restart, still holding
  step(SHOOT, t += DT);
  assert.equal(got[0]?.type, 'press');
  // let go with a flickering none/open: released, and the HUD must stop saying shoot
  let st;
  for (const ext of [NONE, OPEN, NONE]) st = step(ext, t += DT);
  assert.equal(got.at(-1).type, 'release');
  assert.notEqual(st.gesture, 'shoot');
  // any frame the HUD says shoot, the last action the game got is a press
  for (const ext of [SHOOT, NONE, SHOOT, SHOOT, OPEN, SHOOT, NONE, NONE, NONE, SHOOT, SHOOT]) {
    st = step(ext, t += DT);
    if (st.gesture === 'shoot') assert.equal(got.at(-1).type, 'press');
  }
});

test('level comes from the palm centre, in thirds of the preview', async () => {
  const { palmCenter } = await import('../src/hand-classify.js');
  const at = (y) => Array.from({ length: 21 }, () => ({ x: 0.3, y, z: 0 }));
  assert.equal(palmCenter(at(0.2)).y, 0.2);
});

test('a held web survives a tilted hand that reads none, but lets go on an open hand or a folded index', async () => {
  const { stillHolding } = await import('../src/hand-classify.js');
  assert.equal(stillHolding([70, 50, 50, 75]), true); // tilted thwip: index/pinky past 60 but within slack
  assert.equal(stillHolding([10, 10, 10, 10]), false); // flat open hand
  assert.equal(stillHolding([120, 120, 120, 20]), false); // index folded
});
