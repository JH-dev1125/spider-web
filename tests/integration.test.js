// The merged game on the ragdoll: muscle stability, the rooftop start, the two-hand grip, the hero landing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, startGame, createBot } from '../src/game.js';
import { MOVES, FLIGHT } from '../src/moves.js';

const DT = 1 / 60;
const bodies = (g) => Object.values(g.phys.rag.bodies);
const maxSpin = (g) => Math.max(...bodies(g).map((b) => b.angularVelocity.length()));

// Joint tracking error: the angle between each joint's target (relative to its parent) and where it is.
const trackErr = (g) => g.phys.rag.joints.map((j) => {
  const t = g.phys.rag.targets, want = t[j.a.parent].conjugate().mult(t[j.a.name]);
  const d = want.conjugate().mult(j.parent.quaternion.conjugate().mult(j.body.quaternion));
  return 2 * Math.acos(Math.min(1, Math.abs(d.w))) * 180 / Math.PI;
});

test('muscles: firm (mean joint tracking < 10 deg on the rope), stable (rare > 40 rad/s), no NaN in bot play', () => {
  const g = createGame(1);
  for (let i = 0; i < 30; i++) { stepGame(g, DT, []); assert.ok(maxSpin(g) < 40, `frame ${i}: ${maxSpin(g).toFixed(0)} rad/s`); }
  let frames = 0, over = 0, sum = 0, n = 0;
  for (const seed of [1, 2, 3]) {
    const b = createGame(seed), bot = createBot();
    for (let i = 0; i < 60 * 15 && b.player.alive; i++) {
      stepGame(b, DT, bot(b, DT)); frames++;
      if (maxSpin(b) > 40) over++;
      if (b.player.anchor) for (const e of trackErr(b)) { sum += e; n++; }
      assert.ok(bodies(b).every((x) => [x.position.x, x.position.y, x.position.z, x.velocity.x].every(Number.isFinite)), 'NaN');
    }
  }
  assert.ok(sum / n < 10, `mean tracking error on the rope ${(sum / n).toFixed(1)} deg`);
  assert.ok(over / frames < 0.05, `${over} of ${frames} frames over 40 rad/s`);
});

test('core + follower: the core trajectory is identical with or without the ragdoll; the pelvis follows the core', () => {
  for (const seed of [1, 4]) {
    const a = createGame(seed), b = createGame(seed, { rig: false }), ba = createBot(), bb = createBot();
    let gap = 0;
    for (let i = 0; i < 60 * 20 && a.player.alive; i++) {
      stepGame(a, DT, ba(a, DT)); stepGame(b, DT, bb(b, DT));
      assert.deepEqual(a.player.pos, b.player.pos, `seed ${seed} frame ${i}`);
      assert.deepEqual(a.player.vel, b.player.vel);
      const pel = a.phys.rag.bodies.pelvis.position, c = a.phys.hero.position.vadd(a.phys.rig.lift);
      gap = Math.max(gap, pel.distanceTo(c));
    }
    assert.equal(b.phys.rag, null);
    assert.ok(gap < 0.5, `seed ${seed}: the pelvis strayed ${gap.toFixed(2)} m from the core`);
  }
});

test('rooftop start: he stands on the start tower edge with no input for 3 s, then Space dives him off it', () => {
  const g = createGame(3, { start: 'roof' }), s = g.world.start;
  assert.ok(g.world.structures.includes(s), 'the start tower is a structure');
  const near = g.world.structures.filter((t) => t !== s && t.max.z > -60 && t.min.z < 160 && t.kind === 'tower');
  assert.ok(near.every((t) => t.max.y < s.max.y), 'the tallest roof near the start');
  const head0 = g.phys.rag.bodies.head.position.y;
  for (let i = 0; i < 180; i++) stepGame(g, DT, [{ type: 'press', side: 'R', level: 'hi' }]); // presses do nothing here
  assert.equal(g.pose, 'idle');
  assert.equal(g.web, null);
  assert.ok(Math.abs(g.player.pos.z - (s.max.z - 0.35)) < 0.3 && g.player.pos.y > s.max.y + CFG.heroRadius - 0.05, 'still at the edge');
  assert.ok(g.phys.rag.bodies.pelvis.position.y > s.max.y + 0.8, 'upright');
  assert.ok(g.phys.rag.bodies.head.position.y > head0 - 0.3, 'standing');
  assert.ok(startGame(g));
  let left = null;
  for (let i = 0; i < 90; i++) {
    stepGame(g, DT, []);
    if (left === null && g.player.pos.z > s.max.z + 0.3) left = i * DT;
  }
  assert.ok(left !== null && left <= 0.5, `left the roof at ${left}`);
  assert.equal(g.phys.startPhase, 'dive');
  // and a first web holds before he gets near the street
  const bot = createBot();
  let held = false;
  for (let i = 0; i < 60 * 8 && g.player.alive && !held; i++) { stepGame(g, DT, bot(g, DT)); held = !!g.player.anchor; }
  assert.ok(held && g.player.pos.y > 20, `first rope at ${g.player.pos.y.toFixed(0)} m`);
});

test('two-hand grip: on the rope both hands hold the line (within 0.25 m of it after 0.3 s); strain follows tension', () => {
  let checked = 0, near = 0;
  for (const seed of [1, 2, 3]) {
    const g = createGame(seed), bot = createBot();
    let held = 0;
    for (let i = 0; i < 60 * 12 && g.player.alive; i++) {
      stepGame(g, DT, bot(g, DT));
      const ph = g.phys;
      held = ph.rope && !ph.wall ? held + DT : 0;
      if (held < 0.3 || g.player.ropePoints.length) continue;
      const a = ph.anchor.position, c = ph.hero.position, u = a.vsub(c); u.normalize();
      for (const side of ['L', 'R']) {
        const w = ph.rag.bodies['hand' + side].position.vsub(c), off = w.vsub(u.scale(w.dot(u))).length();
        assert.ok(off < 0.6, `hand ${side} ${off.toFixed(2)} m off the line`);
        if (off < 0.25) near++;
        checked++;
      }
      assert.ok(ph.load >= 0 && ph.load <= 1);
    }
  }
  assert.ok(checked > 600, `only ${checked} hand frames`);
  assert.ok(near / checked > 0.95, `the hands within 0.25 m of the line on only ${(100 * near / checked).toFixed(1)}% of frames`);
});

// The classic superhero landing: ONE knee down (the other leg bent, its foot planted), one fist on the street, the other
// arm back and out, the torso within 35 deg of upright. Muscles stay on; no NaN; held, not folded flat.
test('hero landing: one knee and one fist on the street, the other foot planted, the other arm up, torso <= 35 deg (8 deaths)', () => {
  const lowest = (body) => {
    const h = body.shapes[0].halfExtents;
    let m = Infinity;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) m = Math.min(m, body.pointToWorldFrame({ x: x * h.x, y: y * h.y, z: z * h.z }).y);
    return m;
  };
  for (let seed = 1; seed <= 8; seed++) {
    const g = createGame(seed), bot = createBot();
    for (let i = 0; i < 60 * (3 + seed % 4) && g.player.alive; i++) stepGame(g, DT, bot(g, DT)); // swing a while..
    stepGame(g, DT, [{ type: 'release' }]);
    let ev = [];
    for (let i = 0; i < 1800 && g.player.alive; i++) ev = stepGame(g, DT, []); // ..then let go and fall
    assert.ok(ev.includes('dead') && ev.includes('landingImpact'), `seed ${seed}`);
    assert.equal(g.phys.motion.move, MOVES.landing);
    for (let i = 0; i < 60 * (CFG.moves.landingSettleSec + 0.5); i++) stepGame(g, DT, []);
    const b = g.phys.rag.bodies, at = `seed ${seed}`;
    assert.ok(bodies(g).every((x) => x.velocity.length() < 1.5), `${at}: settled`);
    assert.ok(bodies(g).every((x) => [x.position.x, x.position.y, x.position.z].every(Number.isFinite) && x.position.y > 0), `${at}: nothing through the street`);
    assert.ok(lowest(b.shinL) < 0.04, `${at}: the left knee is down (${lowest(b.shinL).toFixed(2)} m)`);
    assert.ok(lowest(b.handL) < 0.04, `${at}: the left fist is on the street (${lowest(b.handL).toFixed(2)} m)`);
    assert.ok(lowest(b.footR) < 0.04, `${at}: the right foot is planted`);
    assert.ok(b.shinR.pointToWorldFrame({ x: 0, y: .195, z: 0 }).y > 0.2, `${at}: the right knee is up (one knee only)`);
    assert.ok(lowest(b.handR) > 0.2, `${at}: the right arm is back and out, off the street`);
    const up = b.chest.quaternion.vmult({ x: 0, y: 1, z: 0 }), torso = Math.acos(Math.min(1, up.y)) * 180 / Math.PI;
    assert.ok(torso <= 35, `${at}: torso ${torso.toFixed(0)} deg from upright`);
    assert.ok(b.pelvis.position.y > 0.25, `${at}: held up off the street, not folded flat`);
  }
});

test('CFG.heroMass is the ragdoll: the ANATOMY masses sum to it (70 kg)', async () => {
  const { ANATOMY } = await import('../src/ragdoll.js');
  assert.equal(ANATOMY.reduce((m, a) => m + a.mass, 0), CFG.heroMass);
  assert.equal(CFG.heroMass, 70);
});

test('flight chain: a 60 s bot run cycles at least 10 distinct moves and never idles in glide longer than 0.4 s', () => {
  const g = createGame(1), bot = createBot({ freeSec: 1.5 }), seen = new Set(); // a player who flies between ropes
  let idle = 0;
  for (let i = 0; i < 60 * 60; i++) {
    stepGame(g, DT, bot(g, DT));
    if (FLIGHT[g.phys.flightMove]) seen.add(g.phys.flightMove);
    idle = Math.max(idle, g.phys.glideIdle);
  }
  assert.ok(g.player.alive, 'survived the minute');
  assert.ok(seen.size >= 10, `${seen.size} distinct: ${[...seen].join(' ')}`);
  assert.ok(idle <= 0.4, `idled ${idle.toFixed(2)} s in glide`);
});
