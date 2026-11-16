// The merged game on the ragdoll: muscle stability, the rooftop start, the two-hand grip, the hero landing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, startGame, createBot } from '../src/game.js';
import { MOVES } from '../src/moves.js';

const DT = 1 / 60;
const bodies = (g) => Object.values(g.phys.rag.bodies);
const maxSpin = (g) => Math.max(...bodies(g).map((b) => b.angularVelocity.length()));

test('muscles are stable: inertia-scaled gains, no body spins past 40 rad/s on the first steps; spikes stay rare in bot play', () => {
  const g = createGame(1);
  for (let i = 0; i < 30; i++) { stepGame(g, DT, []); assert.ok(maxSpin(g) < 40, `frame ${i}: ${maxSpin(g).toFixed(0)} rad/s`); }
  let frames = 0, over = 0;
  for (const seed of [1, 2, 3]) {
    const b = createGame(seed), bot = createBot();
    for (let i = 0; i < 60 * 15 && b.player.alive; i++) {
      stepGame(b, DT, bot(b, DT)); frames++;
      if (maxSpin(b) > 40) over++;
      assert.ok(bodies(b).every((x) => [x.position.x, x.position.y, x.position.z, x.velocity.x].every(Number.isFinite)), 'NaN');
    }
  }
  assert.ok(over / frames < 0.01, `${over} of ${frames} frames over 40 rad/s`);
});

test('rooftop start: he stands on the start tower edge with no input for 3 s, then Space back-tumbles him off it', () => {
  const g = createGame(3, { start: 'roof' }), s = g.world.start;
  assert.ok(g.world.structures.includes(s), 'the start tower is a structure');
  const near = g.world.structures.filter((t) => t !== s && t.max.z > -60 && t.min.z < 160 && t.kind === 'tower');
  assert.ok(near.every((t) => t.max.y < s.max.y), 'the tallest roof near the start');
  const head0 = g.phys.rag.bodies.head.position.y;
  for (let i = 0; i < 180; i++) stepGame(g, DT, [{ type: 'press', side: 'R', level: 'hi' }]); // presses do nothing here
  assert.equal(g.pose, 'idle');
  assert.equal(g.web, null);
  assert.ok(Math.abs(g.player.pos.z - (s.max.z - 0.35)) < 0.3 && g.player.pos.y > s.max.y + 0.8, 'still at the edge, upright');
  assert.ok(g.phys.rag.bodies.head.position.y > head0 - 0.3, 'standing');
  assert.ok(startGame(g));
  let left = null, pitch = 0;
  for (let i = 0; i < 90; i++) {
    stepGame(g, DT, []);
    if (g.phys.startPhase === 'tumble') pitch += Math.abs(g.phys.rag.bodies.pelvis.angularVelocity.x) * DT;
    if (left === null && g.player.pos.z > s.max.z + 0.3) left = i * DT;
  }
  assert.ok(left !== null && left <= 0.5, `left the roof at ${left}`);
  assert.ok(pitch * 180 / Math.PI > 270, `pitched ${(pitch * 180 / Math.PI).toFixed(0)} deg`);
  assert.equal(g.phys.startPhase, 'play');
  // and a first web holds before he gets near the street
  const bot = createBot();
  let held = false;
  for (let i = 0; i < 60 * 8 && g.player.alive && !held; i++) { stepGame(g, DT, bot(g, DT)); held = !!g.player.anchor; }
  assert.ok(held && g.player.pos.y > 20, `first rope at ${g.player.pos.y.toFixed(0)} m`);
});

test('two-hand grip: both hands hold the rope (two pull-only constraints), within 0.25 m of the line after 0.3 s; strain follows tension', () => {
  let checked = 0, near = 0;
  for (const seed of [1, 2, 3]) {
  const g = createGame(seed), bot = createBot();
  for (let i = 0; i < 60 * 12 && g.player.alive; i++) {
    stepGame(g, DT, bot(g, DT));
    const ph = g.phys;
    if (!ph.rope || !ph.grip || ph.grip.sec < 0.3 || g.player.ropePoints.length) continue;
    const a = ph.anchor.position, h = ph.rope.bodyA.position, o = ph.grip.rope.bodyA.position;
    assert.notEqual(ph.rope.bodyA, ph.grip.rope.bodyA);
    const d = a.vsub(h), n = d.length(), u = d.scale(1 / n), w = o.vsub(h);
    const off = w.vsub(u.scale(w.dot(u))).length();
    assert.ok(off < 0.5, `the other hand ${off.toFixed(2)} m off the line`);
    if (off < 0.25) near++;
    assert.ok(ph.load >= 0 && ph.load <= 1);
    checked++;
  }
  }
  assert.ok(checked > 300, `only ${checked} two-hand frames`);
  assert.ok(near / checked > 0.95, `the hands within 0.25 m of the line on only ${(100 * near / checked).toFixed(1)}% of frames`);
});

test('hero landing: street contact starts the landing, muscles stay on, he comes to rest low with no NaN', () => {
  const g = createGame(2);
  let ev = [];
  for (let i = 0; i < 600 && g.player.alive; i++) ev = stepGame(g, DT, []);
  assert.ok(ev.includes('dead') && ev.includes('landingImpact'));
  assert.equal(g.phys.motion.move, MOVES.landing);
  for (let i = 0; i < 60 * 2; i++) stepGame(g, DT, []);
  assert.ok(g.phys.landing.sec >= CFG.moves.landingSettleSec);
  assert.ok(bodies(g).every((b) => b.velocity.length() < 1.5), 'settled');
  assert.ok(bodies(g).every((b) => b.position.y > 0), 'nothing through the street');
  assert.ok(g.phys.rag.bodies.pelvis.position.y > 0.3, 'held up off the street, not folded flat');
});

test('CFG.heroMass is the ragdoll: the ANATOMY masses sum to it (70 kg)', async () => {
  const { ANATOMY } = await import('../src/ragdoll.js');
  assert.equal(ANATOMY.reduce((m, a) => m + a.mass, 0), CFG.heroMass);
  assert.equal(CFG.heroMass, 70);
});

test('flight chain: a 60 s bot run cycles at least 10 distinct moves and never idles in glide longer than 0.4 s', () => {
  const g = createGame(1), bot = createBot(), seen = new Set();
  let idle = 0;
  for (let i = 0; i < 60 * 60; i++) {
    stepGame(g, DT, bot(g, DT));
    if (g.phys.flightMove && g.phys.flightMove !== 'preland') seen.add(g.phys.flightMove);
    idle = Math.max(idle, g.phys.glideIdle);
  }
  assert.ok(g.player.alive, 'survived the minute');
  assert.ok(seen.size >= 10, `${seen.size} distinct: ${[...seen].join(' ')}`);
  assert.ok(idle <= 0.4, `idled ${idle.toFixed(2)} s in glide`);
});
