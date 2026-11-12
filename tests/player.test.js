import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createPlayer, createPhysics, syncStructures, raycast, attach, release, stepPhysics } from '../src/player.js';

const DT = 1 / 60;
const H = CFG.physicsStep;
const box = (id, kind, min, max, attachable = kind !== 'frame') => ({ id, kind, min, max, attach: attachable });
const len3 = (v) => Math.hypot(v.x, v.y, v.z);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function setup({ pos, vel, structures = [] } = {}) {
  const p = createPlayer();
  if (pos) p.pos = { ...pos };
  if (vel) p.vel = { ...vel };
  const ph = createPhysics(p);
  syncStructures(ph, structures);
  return { p, ph };
}
const inside = (p, s) => ['x', 'y', 'z'].every((k) => p[k] > s.min[k] && p[k] < s.max[k]);

test('free flight: plain gravity plus a little quadratic drag', () => {
  const { p, ph } = setup({ vel: { x: 0, y: 0, z: 0 } });
  for (let i = 0; i < 60; i++) stepPhysics(ph, p, DT);
  assert.ok(p.vel.y < -9.7 && p.vel.y > -9.81, `vy ${p.vel.y}`);
  assert.ok(Math.abs(p.pos.y - (CFG.startHeight - 0.5 * CFG.gravity)) < 0.15);
});

test('fixed step: dt is consumed in whole physics steps, the remainder carries over', () => {
  const a = setup(), b = setup();
  for (let i = 0; i < 120; i++) stepPhysics(a.ph, a.p, DT);
  for (let i = 0; i < 240; i++) stepPhysics(b.ph, b.p, DT / 2);
  assert.ok(dist(a.p.pos, b.p.pos) < 1e-9); // same steps, same result
  const c = setup();
  stepPhysics(c.ph, c.p, H * 0.5);
  assert.equal(c.p.pos.y, CFG.startHeight); // not a whole step yet
});

test('air drag caps the fall near sqrt(g / airDrag)', () => {
  const { p, ph } = setup({ pos: { x: 0, y: 3000, z: 0 }, vel: { x: 0, y: 0, z: 0 } });
  for (let i = 0; i < 60 * 30; i++) stepPhysics(ph, p, DT);
  const vt = Math.sqrt(CFG.gravity / CFG.airDrag);
  assert.ok(Math.abs(-p.vel.y - vt) < 1, `${-p.vel.y} vs ${vt}`);
});

test('the rope pulls but never pushes; held taut it keeps the hero within its length', () => {
  const anchor = { x: 0, y: 60, z: 30 };
  const { p, ph } = setup({ pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 10 } });
  assert.ok(attach(ph, p, anchor));
  for (let i = 0; i < 240; i++) {
    stepPhysics(ph, p, DT);
    // SPOOK lags the reel by about one step
    assert.ok(dist(p.pos, anchor) <= p.ropeLen + CFG.reelSpeed * H * 1.5 + 0.01, `stretched at frame ${i}`);
  }
  // hero flying straight at the anchor: the rope goes slack and takes up the slack without pushing back
  const s = setup({ pos: { x: 0, y: 60, z: 0 }, vel: { x: 0, y: 0, z: 20 } });
  attach(s.ph, s.p, anchor);
  stepPhysics(s.ph, s.p, DT);
  assert.ok(Math.abs(s.p.vel.z - 20 * (1 - CFG.airDrag * 20 * DT)) < 0.01, `vz ${s.p.vel.z}`);
});

test('the rope only ever shortens: reeled smoothly to ropeMin (slack take-up may go shorter)', () => {
  const anchor = { x: 14, y: 80, z: 40 };
  const { p, ph } = setup({ pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 0 } });
  attach(ph, p, anchor);
  const L0 = p.ropeLen;
  assert.equal(p.ropeMin, L0 * CFG.reelMinFactor);
  let prev = L0;
  for (let i = 0; i < 60 * 8; i++) {
    stepPhysics(ph, p, DT);
    assert.ok(p.ropeLen <= prev + 1e-9 && p.ropeLen >= CFG.minRopeLen);
    const taut = dist(p.pos, anchor) >= p.ropeLen - 0.01;
    if (taut && prev > p.ropeMin) assert.ok(prev - p.ropeLen <= CFG.reelSpeed * DT + 1e-9, 'reel faster than reelSpeed');
    prev = p.ropeLen;
  }
  assert.ok(p.ropeLen <= p.ropeMin + 1e-9);
});

test('release removes the rope and leaves the velocity exactly as the swing made it', () => {
  const { p, ph } = setup({ vel: { x: 0, y: 0, z: 12 } });
  attach(ph, p, { x: -14, y: 64, z: 52 });
  for (let i = 0; i < 150; i++) stepPhysics(ph, p, DT);
  const v = { ...p.vel };
  const hv = ph.hero.velocity;
  assert.ok(release(ph, p));
  assert.deepEqual({ x: hv.x, y: hv.y, z: hv.z }, v);
  assert.equal(p.anchor, null);
  assert.equal(ph.world.constraints.length, 0);
  assert.equal(release(ph, p), false);
});

test('solid: a hero thrown at 57 m/s into a tower or a frame beam never ends up inside it', () => {
  const W = CFG.corridorHalfWidth;
  const tower = box('t:base', 'tower', { x: W, y: 0, z: 0 }, { x: W + 20, y: 100, z: 200 });
  const beam = box('f:post0', 'frame', { x: -0.8, y: 0, z: 60 }, { x: 0.8, y: 100, z: 60 + CFG.level.beam });
  for (const [s, vel] of [[tower, { x: 57, y: 0, z: 5 }], [beam, { x: 0, y: 0, z: 57 }], [tower, { x: 40, y: 0, z: 40 }]]) {
    const { p, ph } = setup({ pos: { x: 0, y: 60, z: 10 }, vel, structures: [s] });
    for (let i = 0; i < 120; i++) {
      stepPhysics(ph, p, DT);
      assert.ok(!inside(p.pos, s), `${s.id}: inside at frame ${i} ${JSON.stringify(p.pos)}`);
    }
  }
});

test('raycast: closest hit, attach comes from the structure, frames and the street do not hold', () => {
  const W = CFG.corridorHalfWidth;
  const frame = [
    box('f:post0', 'frame', { x: W, y: 0, z: 40 }, { x: W + 1.6, y: 40, z: 41.6 }),
    box('f:post1', 'frame', { x: W, y: 0, z: 70 }, { x: W + 1.6, y: 40, z: 71.6 }),
    box('f:beam0', 'frame', { x: W, y: 38.4, z: 40 }, { x: W + 1.6, y: 40, z: 71.6 }),
  ];
  const behind = box('t:base', 'tower', { x: W + 20, y: 0, z: 0 }, { x: W + 40, y: 80, z: 200 });
  const { ph } = setup({ structures: [...frame, behind] });
  const from = { x: 0, y: 20, z: 0 };
  const through = raycast(ph, from, { x: Math.sin(0.3), y: 0, z: Math.cos(0.3) }, 200); // through the frame's open middle
  assert.ok(through.attach && Math.abs(through.point.x - (W + 20)) < 1e-6);
  const d = { x: W + 0.8, y: 0, z: 40.8 }; // straight at the first post
  const post = raycast(ph, from, { x: d.x / len3(d), y: 0, z: d.z / len3(d) }, 200);
  assert.ok(post && !post.attach && post.point.x >= W - 1e-6 && post.point.x < W + 1.6, 'a post blocks the web');
  const street = raycast(ph, from, { x: 0, y: -1, z: 0 }, 200);
  assert.ok(street && !street.attach && Math.abs(street.point.y) < 1e-6);
  assert.equal(raycast(ph, from, { x: -1, y: 0, z: 0 }, 50), null);
});

test('syncStructures adds new boxes and removes the ones the world dropped', () => {
  const a = box('a:base', 'tower', { x: 14, y: 0, z: 0 }, { x: 30, y: 50, z: 40 });
  const b = box('b:base', 'tower', { x: -30, y: 0, z: 0 }, { x: -14, y: 50, z: 40 });
  const { ph } = setup({ structures: [a, b] });
  assert.deepEqual([...ph.boxes.keys()], ['a:base', 'b:base']);
  syncStructures(ph, [b]);
  assert.deepEqual([...ph.boxes.keys()], ['b:base']);
  assert.ok(!ph.world.bodies.some((x) => x.structure === a));
});

test('touching the street is death: one dead event, the rope goes, the body stops', () => {
  const { p, ph } = setup({ pos: { x: 0, y: 5, z: 0 } });
  assert.ok(attach(ph, p, { x: 14, y: 4, z: 30 })); // a low anchor cannot hold him up
  const ev = [];
  for (let i = 0; i < 180; i++) ev.push(...stepPhysics(ph, p, DT));
  assert.deepEqual(ev.filter((e) => e === 'dead'), ['dead']);
  assert.equal(p.alive, false);
  assert.equal(p.anchor, null);
  assert.deepEqual(p.vel, { x: 0, y: 0, z: 0 });
});
