import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { aimVector, castWeb } from '../src/web.js';
import { createPlayer, attach, detach, stepPlayer } from '../src/player.js';

const DT = 1 / 60;
const W = CFG.corridorHalfWidth;
const V = CFG.baseSpeed;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const towers = [
  { side: 'R', z0: 5, z1: 200, h: 90 },
  { side: 'L', z0: 5, z1: 200, h: 90 },
];
const webFrom = (p, side, level) => castWeb(p.pos, aimVector(side, level), CFG.chargeMax, towers);

test('createPlayer start state; attach reels rope in; detach', () => {
  const p = createPlayer();
  assert.deepEqual(p.pos, { x: 0, y: CFG.startHeight, z: 0 });
  assert.deepEqual(p.vel, { x: 0, y: 0, z: V });
  assert.equal(p.anchor, null);
  assert.equal(p.swingPhase, 'none');
  assert.equal(p.alive, true);
  const a = { x: W, y: 60, z: 20 };
  attach(p, a);
  assert.deepEqual(p.anchor, a);
  assert.ok(Math.abs(p.ropeLen - dist(p.pos, a) * CFG.reelFactor) < 1e-9);
  assert.equal(p.swingPhase, 'descending');
  detach(p);
  assert.equal(p.anchor, null);
});

test('(a) free fall: y strictly decreases until dead', () => {
  const p = createPlayer();
  let prev = p.pos.y;
  let ev = [];
  for (let i = 0; i < 10000 && !ev.includes('dead'); i++) {
    ev = stepPlayer(p, DT, [], V);
    if (!ev.includes('dead')) assert.ok(p.pos.y < prev);
    prev = p.pos.y;
  }
  assert.ok(ev.includes('dead'));
  assert.equal(p.alive, false);
});

test('(b) dt is clamped to maxDt', () => {
  const p = createPlayer();
  p.vel.y = -3;
  const y0 = p.pos.y;
  stepPlayer(p, 5, [], V);
  const bound = 0.5 * CFG.gravity * CFG.maxDt ** 2 + 3 * CFG.maxDt + 1e-6;
  assert.ok(y0 - p.pos.y <= bound, `drop ${y0 - p.pos.y} > ${bound}`);
  assert.ok(p.pos.z <= V * CFG.maxDt + 1e-9);
});

test('(c) right-high-forward anchor: rope holds, then auto-release', () => {
  const p = createPlayer();
  const a = webFrom(p, 'R', 'hi');
  assert.ok(a && a.y > p.pos.y && a.z > p.pos.z && a.x > 0);
  attach(p, a);
  let released = false;
  for (let t = 0; t < 3; t += DT) {
    const ev = stepPlayer(p, DT, towers, V);
    if (p.anchor) assert.ok(dist(p.pos, p.anchor) <= p.ropeLen + 1e-6);
    if (ev.includes('released')) released = true;
    if (released) assert.equal(p.anchor, null);
  }
  assert.ok(released);
  assert.ok(p.alive);
});

test('(d) loop A: a swing ends higher than falling for the same time', () => {
  const p = createPlayer();
  const free = createPlayer();
  attach(p, webFrom(p, 'R', 'hi'));
  let ev = [];
  for (let i = 0; i < 600 && !ev.includes('released'); i++) {
    ev = stepPlayer(p, DT, towers, V);
    stepPlayer(free, DT, towers, V);
  }
  assert.ok(ev.includes('released'));
  assert.ok(p.pos.y > free.pos.y, `swing y ${p.pos.y} vs free ${free.pos.y}`);
  // and the launch carries it above the start height (peak of the release arc)
  const peak = p.pos.y + Math.max(p.vel.y, 0) ** 2 / (2 * CFG.gravity);
  assert.ok(peak > CFG.startHeight, `peak ${peak}`);
});

test('(e) bounce off a right wall', () => {
  const p = createPlayer();
  p.pos.x = W - 0.2;
  p.vel.x = 30;
  const wall = [{ side: 'R', z0: -10, z1: 100, h: 80 }];
  const ev = stepPlayer(p, DT, wall, V);
  assert.ok(ev.includes('bounce'));
  assert.ok(Math.abs(p.pos.x) < W);
  assert.ok(p.vel.x < 0);
  assert.ok(p.alive);
});

test('no building (gap or above roof): x clamped to the corridor', () => {
  const p = createPlayer();
  p.pos.x = -(W - 0.2);
  p.vel.x = -30;
  assert.deepEqual(stepPlayer(p, DT, [{ side: 'L', z0: 0, z1: 100, h: 10 }], V), []);
  assert.equal(p.pos.x, -W);
});

test('rope dragging into the face: no jitter, not stuck, alive', () => {
  // anchor high on the face plane: the pendulum's low point is |x| = W itself
  const face = [{ side: 'R', z0: -50, z1: 400, h: 110 }];
  for (const [x0, vx] of [[W - 0.1, 0], [W - 0.1, 0.5], [10, 1], [10, 8], [10, 20]]) {
    const p = createPlayer();
    p.pos.x = x0;
    p.vel.x = vx;
    attach(p, { x: W, y: 100, z: 25 });
    let bounces = 0;
    let contact = 0;
    let released = false;
    for (let t = 0; t < 6 && !released; t += DT) {
      const ev = stepPlayer(p, DT, face, V);
      if (ev.includes('bounce')) bounces++;
      released = ev.includes('released');
      if (p.pos.x >= W - CFG.wallSkin - 1e-9) contact++;
      assert.ok(Math.abs(p.pos.x) < W, `x ${p.pos.x}`);
      if (p.anchor) assert.ok(dist(p.pos, p.anchor) <= p.ropeLen + 1e-6);
    }
    assert.ok(contact > 0, `vx ${vx}: never reached the face`);
    assert.ok(released, `vx ${vx}: never released`);
    assert.ok(bounces <= (vx < 1 && x0 > W - 1 ? 0 : 2), `vx ${vx}: bounces ${bounces}`);
    assert.ok(p.alive);
  }
});

test('low anchor passed over still swings up and releases', () => {
  const p = createPlayer();
  attach(p, webFrom(p, 'L', 'lo'));
  let released = false;
  for (let t = 0; t < 3 && !released; t += DT) released = stepPlayer(p, DT, towers, V).includes('released');
  assert.ok(released);
});

test('(f) vel.z never below minForwardSpeed', () => {
  const min = V + 8;
  const p = createPlayer();
  attach(p, webFrom(p, 'R', 'hi'));
  for (let t = 0; t < 3; t += DT) {
    stepPlayer(p, DT, towers, min);
    assert.ok(p.vel.z >= min);
  }
});

test('(g) ceiling caps height', () => {
  const p = createPlayer();
  p.vel.y = 100;
  for (let t = 0; t < 3; t += DT) {
    stepPlayer(p, DT, [], V);
    assert.ok(p.pos.y <= CFG.ceiling);
  }
});
