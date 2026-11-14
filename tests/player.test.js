import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createPlayer, createPhysics, syncStructures, raycast, attach, release, stepPhysics, setZip } from '../src/player.js';

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
  const vt = Math.sqrt(CFG.gravity / CFG.airDrag), vy = -vt * Math.tanh(CFG.gravity / vt); // falling from rest for 1 s
  assert.ok(Math.abs(p.vel.y - vy) < 0.05 && p.vel.y > -CFG.gravity, `vy ${p.vel.y} vs ${vy}`);
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

test('landing on a roof never leaves the hero stuck: he runs forward off the edge', () => {
  const p = createPlayer();
  p.pos = { x: 0, y: 30 + CFG.heroRadius, z: 0 };
  p.vel = { x: 0, y: 0, z: 0 };
  const ph = createPhysics(p);
  syncStructures(ph, [{ id: 'roof', kind: 'tower', min: { x: -10, y: 0, z: -5 }, max: { x: 10, y: 30, z: 20 }, attach: true }]);
  for (let i = 0; i < 60 * 4 && p.alive; i++) stepPhysics(ph, p, 1 / 60);
  assert.ok(p.pos.z > 20 || !p.alive, `still on the roof at z=${p.pos.z}`);
});

// ---- wall run: a side-face hit with speed into it runs along the face, then jumps off ----
const W = CFG.corridorHalfWidth;
const face = () => box('wr:base', 'tower', { x: W, y: 0, z: -50 }, { x: W + 20, y: 150, z: 400 });
function throwAtWall(vel, structures = [face()]) {
  const s = setup({ pos: { x: W - 3, y: 60, z: 0 }, vel, structures });
  const log = []; // per frame {ev, pos, vel}
  for (let i = 0; i < 90; i++) {
    const ev = stepPhysics(s.ph, s.p, DT);
    log.push({ ev, pos: { ...s.p.pos }, vel: { ...s.p.vel }, wall: s.p.wall });
    for (const b of structures) assert.ok(!inside(s.p.pos, b), `inside ${b.id} at frame ${i}`);
  }
  return { ...s, log };
}

test('wall run: thrown sideways into a tower face he runs along it for ~wallRunSec, held on, barely sinking', () => {
  const { log } = throwAtWall({ x: 15, y: -6, z: 20 });
  const r = log.findIndex((f) => f.ev.includes('wallrun')), j = log.findIndex((f) => f.ev.includes('walljump'));
  assert.ok(r >= 0 && j > r, 'run then jump');
  assert.ok(Math.abs((j - r) * DT - CFG.wallRunSec) <= 2 * DT, `ran ${((j - r) * DT).toFixed(3)} s`);
  const run = log.slice(r, j);
  for (const f of run) {
    assert.equal(f.wall, -1);
    assert.ok(W - f.pos.x <= CFG.heroRadius + CFG.wallRunSkin + 1e-6, `left the face: ${W - f.pos.x}`);
  }
  // friction: the run bleeds a little forward speed (about heroFriction * g per second), keeps most of it
  for (let i = 1; i < run.length; i++) assert.ok(run[i].vel.z <= run[i - 1].vel.z + 1e-9, 'no speed gained on the wall');
  const v0 = log[r - 1].vel.z, v1 = run.at(-1).vel.z;
  assert.ok(v1 < v0 - 0.5 * CFG.heroFriction * CFG.gravity * CFG.wallRunSec, `no friction: ${v0} -> ${v1}`);
  assert.ok(v1 > 0.85 * v0, `lost too much: ${v0} -> ${v1}`);
  const T = run.length * DT, sink = run[0].pos.y - run.at(-1).pos.y;
  assert.ok(sink < 0.5 * CFG.gravity * T * T, `sank ${sink.toFixed(2)} m in ${T.toFixed(2)} s`);
  assert.ok(sink < CFG.wallRunMaxSink * T + 0.5 * CFG.gravity * CFG.wallRunGravity * T * T + 0.05);
});

test('wall jump: away from the wall, upward, forward speed kept', () => {
  const { log } = throwAtWall({ x: 15, y: -6, z: 20 });
  const j = log.findIndex((f) => f.ev.includes('walljump'));
  const v = log[j].vel;
  assert.ok(v.x < -CFG.wallJump.out * 0.9, `vx ${v.x}`);
  assert.ok(v.y > CFG.wallJump.up * 0.9, `vy ${v.y}`);
  assert.ok(v.z >= 20, `vz ${v.z}`);
  assert.ok(log.at(-1).pos.x < W - 3, 'flew off the wall');
});

test('friction: grazing a facade costs a little speed, and he never sticks to it', () => {
  const vel = { x: CFG.wallRunMinSpeed * 0.8, y: 0, z: 20 }; // too slow into the face for a wall run
  const graze = throwAtWall(vel), free = throwAtWall(vel, []);
  assert.ok(!graze.log.some((f) => f.ev.includes('wallrun')));
  const vz = graze.log.at(-1).vel.z, vzFree = free.log.at(-1).vel.z;
  assert.ok(vz < vzFree - 0.05 && vz > 0.9 * vzFree, `grazed ${vz.toFixed(2)} vs ${vzFree.toFixed(2)} m/s`);
  assert.ok(graze.log.at(-1).pos.z > 25, 'kept going along the wall');
});

test('wall run: a slow bump or a roof landing is no wall run', () => {
  assert.ok(!throwAtWall({ x: CFG.wallRunMinSpeed * 0.5, y: 0, z: 10 }).log.some((f) => f.ev.includes('wallrun')));
  const roof = setup({ pos: { x: W + 10, y: 152, z: 0 }, vel: { x: 0, y: -8, z: 10 }, structures: [face()] });
  for (let i = 0; i < 30; i++) assert.ok(!stepPhysics(roof.ph, roof.p, DT).includes('wallrun'));
});

test('wall run cooldown: driven straight back into the face, no new run until wallRunCooldownSec', () => {
  const { p, ph } = setup({ pos: { x: W - 3, y: 60, z: 0 }, vel: { x: 15, y: 0, z: 20 }, structures: [face()] });
  let t = 0, jumpT = null, again = null;
  for (let i = 0; i < 180; i++, t += DT) {
    if (jumpT !== null) ph.hero.velocity.x = 12; // keep shoving him into the wall
    const ev = stepPhysics(ph, p, DT);
    if (ev.includes('walljump') && jumpT === null) jumpT = t;
    else if (ev.includes('wallrun') && jumpT !== null) { again = t; break; }
  }
  assert.ok(jumpT !== null && again !== null, 'ran again once the cooldown was over');
  assert.ok(again - jumpT >= CFG.wallRunCooldownSec - DT, `ran again after ${(again - jumpT).toFixed(2)} s`);
});

test('wall run with a rope: the rope still holds him, and a zip into a wall lands in a wall run', () => {
  const anchor = { x: W, y: 90, z: 60 };
  const s = setup({ pos: { x: W - 3, y: 60, z: 0 }, vel: { x: 15, y: 0, z: 20 }, structures: [face()] });
  assert.ok(attach(s.ph, s.p, anchor));
  let ran = false;
  for (let i = 0; i < 60; i++) {
    ran = stepPhysics(s.ph, s.p, DT).includes('wallrun') || ran;
    assert.ok(dist(s.p.pos, anchor) <= s.p.ropeLen + 0.5, `rope stretched at frame ${i}`);
  }
  assert.ok(ran && s.p.anchor, 'ran along the wall on the rope');
  // zip at a wall anchor ahead: auto-release short of it, the momentum carries him into the face, a wall run
  const z = setup({ pos: { x: 0, y: 60, z: 0 }, vel: { x: 0, y: 0, z: 12 }, structures: [face()] });
  attach(z.ph, z.p, { x: W, y: 62, z: 30 });
  setZip(z.ph, true);
  const ev = [];
  for (let i = 0; i < 120; i++) {
    ev.push(...stepPhysics(z.ph, z.p, DT));
    assert.ok(!inside(z.p.pos, face()), `zip: inside at frame ${i}`);
  }
  assert.ok(ev.includes('zipped'), 'zip let go');
  assert.ok(ev.indexOf('wallrun') > ev.indexOf('zipped'), `events ${ev.join(' ')}`);
});
