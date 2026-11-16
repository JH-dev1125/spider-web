// Rope wrapping (src/rope.js): an attached rope bends round the structure edges it swings into and straightens again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, createBot } from '../src/game.js';
import { attach } from '../src/player.js';

const DT = 1 / 60;
const PILLAR = { id: 'P1:base', kind: 'tower', attach: true, min: { x: 5, y: 0, z: 30 }, max: { x: 7, y: 100, z: 32 } };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
// The whole rope: anchor -> bends -> hero.
const polyline = (p) => [p.anchor, ...p.ropePoints, p.pos];
const total = (p) => polyline(p).slice(0, -1).reduce((s, q, i, a) => s + (i ? dist(a[i - 1], q) : 0), 0) + p.ropeLen; // wrapped + free

// Does segment a-b pass through the inside of box s (shrunk by eps, so touching an edge or face doesn't count)?
function cuts(a, b, s, eps = 1e-3) {
  let t0 = 0, t1 = 1;
  for (const k of ['x', 'y', 'z']) {
    const d = b[k] - a[k], lo = s.min[k] + eps, hi = s.max[k] - eps;
    if (Math.abs(d) < 1e-12) { if (a[k] <= lo || a[k] >= hi) return false; continue; }
    const u = (lo - a[k]) / d, v = (hi - a[k]) / d;
    t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
    if (t0 >= t1) return false;
  }
  return true;
}

// Hero 15 m from an anchor on a pillar's face, flying past it: he circles the pillar and the rope winds round it.
function circling(speed = 25, reel = false) {
  const g = createGame(1);
  g.world.structures = [PILLAR];
  g.world.fixed = true;
  stepGame(g, DT, []);
  g.phys.hero.position.set(-10, 60, 31);
  g.phys.hero.velocity.set(0, 0, speed);
  assert.ok(attach(g.phys, g.player, { x: 5, y: 60, z: 31 }));
  if (!reel) g.player.ropeMin = Infinity; // no reeling: the rope's whole length must stay exactly the same
  return g;
}

test('a rope swung round a box corner gains a wrap point at that edge, just outside it', () => {
  const g = circling();
  let i = 0;
  for (; i < 120 && !g.player.ropePoints.length; i++) stepGame(g, DT, []);
  assert.equal(g.player.ropePoints.length, 1, 'never wrapped');
  const w = g.player.ropePoints[0], o = CFG.ropeWrapOffset;
  assert.ok(Math.abs(w.x - (PILLAR.min.x - o)) < 1e-6 && Math.abs(w.z - (PILLAR.max.z + o)) < 1e-6, JSON.stringify(w));
  assert.ok(Math.abs(w.y - g.player.anchor.y) < 3, 'on the vertical edge near the rope height');
  // the physics rope now pivots on the bend
  const a = g.phys.anchor.position;
  assert.deepEqual({ x: a.x, y: a.y, z: a.z }, { x: w.x, y: w.y, z: w.z });
});

test('the rope keeps its length through every wrap and unwrap', () => {
  const g = circling();
  const L = total(g.player);
  let wraps = 0, prev = 0;
  for (let i = 0; i < 260 && g.player.anchor; i++) {
    stepGame(g, DT, []);
    const n = g.player.ropePoints.length;
    if (n !== prev) wraps++;
    prev = n;
    assert.ok(Math.abs(total(g.player) - L) < 1e-6, `frame ${i}: ${total(g.player)} vs ${L}`);
  }
  assert.ok(wraps >= 3, `only ${wraps} wrap changes`);
});

test('the rope polyline never passes through a structure, not even for one frame', () => {
  for (const speed of [15, 25, 35]) {
    const g = circling(speed, true);
    for (let i = 0; i < 300 && g.player.anchor; i++) {
      stepGame(g, DT, []);
      const pts = polyline(g.player);
      for (let k = 1; k < pts.length; k++) assert.ok(!cuts(pts[k - 1], pts[k], PILLAR), `speed ${speed} frame ${i}: segment ${k} cuts the pillar`);
    }
  }
});

test('swinging back unwraps', () => {
  const g = circling();
  for (let i = 0; i < 120 && !g.player.ropePoints.length; i++) stepGame(g, DT, []);
  assert.equal(g.player.ropePoints.length, 1);
  for (let i = 0; i < 4; i++) stepGame(g, DT, []);
  const v = g.phys.hero.velocity;
  v.set(-v.x, -v.y, -v.z); // swing back the way he came
  let i = 0;
  for (; i < 120 && g.player.ropePoints.length; i++) stepGame(g, DT, []);
  assert.equal(g.player.ropePoints.length, 0, 'still wrapped');
  assert.ok(i < 60, `took ${i} frames`);
  const a = g.phys.anchor.position;
  assert.deepEqual({ x: a.x, y: a.y, z: a.z }, g.player.anchor);
});

test('more bends than ropeMaxWraps snap the rope: snapped event, rope gone, shown as a miss line', () => {
  const g = circling();
  let ev = [], most = 0;
  for (let i = 0; i < 400 && g.player.anchor; i++) { ev = stepGame(g, DT, []); most = Math.max(most, g.player.ropePoints.length); }
  assert.equal(most, CFG.ropeMaxWraps);
  assert.ok(ev.includes('snapped'), ev.join());
  assert.equal(g.player.anchor, null);
  assert.deepEqual(g.player.ropePoints, []);
  assert.ok(g.missLine, 'the snap is shown');
  assert.equal(g.phys.world.constraints.length, 0);
});

test('bot runs on the generated city: no rope ever passes through a box at the end of a frame', () => {
  let wrapped = 0;
  for (let seed = 1; seed <= 12; seed++) for (const turn of [null, 'R']) {
    const g = createGame(seed), bot = createBot({ turn });
    for (let i = 0; i < 60 * 25 && g.player.alive; i++) {
      stepGame(g, DT, bot(g, DT));
      const p = g.player;
      if (!p.anchor) continue;
      if (p.ropePoints.length) wrapped++;
      const pts = polyline(p);
      for (const s of g.world.structures) for (let k = 1; k < pts.length; k++) {
        assert.ok(!cuts(pts[k - 1], pts[k], s, 0.05), `seed ${seed} turn ${turn} frame ${i}: rope through ${s.id}`);
      }
    }
  }
  assert.ok(wrapped > 0, 'no rope ever wrapped on the city');
});
