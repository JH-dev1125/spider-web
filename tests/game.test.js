import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, createBot, pickTrickPose } from '../src/game.js';
import { makeRng } from '../src/world.js';

const DT = 1 / 60;
const W = CFG.corridorHalfWidth;
const shot = (side, level) => ({ type: 'press', side, level });
const REL = { type: 'release' };
const speed = (v) => Math.hypot(v.x, v.y, v.z);
const block = (id, kind, min, max) => ({ id, kind, attach: kind !== 'frame', min, max });
const tower = (id, sd, z0, z1, h) => block(`${id}:base`, 'tower',
  { x: sd > 0 ? W : -W - 20, y: 0, z: z0 }, { x: sd > 0 ? W + 20 : -W, y: h, z: z1 });
// Replace the generated course with a fixed one (no more generation). Test ids must not reuse generated ones
// ('L0:base'...): physics boxes are keyed by id.
function course(g, structures) {
  g.world.structures = structures;
  g.world.nextZ = { L: Infinity, R: Infinity };
}
const walls = (g, h = 200) => course(g, [tower('WL', -1, -50, 2000, h), tower('WR', 1, -50, 2000, h)]);
// Keep holding while the web is in flight (it lands after dist / webSpeed).
function fly(g) {
  for (let i = 0; i < 600 && g.web; i++) stepGame(g, DT, []);
}
// Hold until the swing climbs at `climb` (vel.y / speed) past its bottom.
function swingUntilClimb(g, climb = 0.5) {
  fly(g);
  for (let i = 0; i < 600 && g.player.anchor; i++) {
    const v = g.player.vel;
    if (g.player.swingPhase === 'ascending' && v.y >= climb * speed(v)) return true;
    stepGame(g, DT, []);
  }
  return false;
}

test('createGame: populated course, live player at the gentle start, glide pose', () => {
  const g = createGame(1);
  assert.ok(g.world.structures.length > 0);
  assert.equal(g.phys.boxes.size, g.world.structures.length);
  assert.equal(g.player.alive, true);
  assert.equal(g.pose, 'glide');
  assert.equal(g.missLine, null);
  assert.deepEqual(g.player.vel, { x: 0, y: 0, z: CFG.startSpeed });
});

test('a press launches a web from the hand; it attaches when it lands (dist / webSpeed), then swing pose', () => {
  const g = createGame(1);
  walls(g);
  stepGame(g, DT, [shot('R', 'mid')]);
  const w = g.web;
  assert.ok(w && w.hit && !g.player.anchor);
  const p = g.player;
  assert.deepEqual(w.from, { x: p.pos.x, y: p.pos.y + CFG.render.playerHand, z: p.pos.z }); // follows the hand
  const frames = Math.ceil(w.dist / (CFG.webSpeed * DT));
  assert.ok(frames >= 6 && frames * DT >= 0.1 && frames * DT <= 0.2, `flight ${frames} frames`);
  for (let i = 1; i < frames; i++) {
    assert.ok(g.web && !g.player.anchor, `landed early at frame ${i}`);
    assert.ok(Math.abs(g.web.travelled - i * CFG.webSpeed * DT) < 1e-6);
    stepGame(g, DT, []);
  }
  assert.equal(g.web, null);
  assert.deepEqual(g.player.anchor, w.to);
  assert.ok(Math.abs(w.to.z - CFG.aimAhead) < 2, `lands ${w.to.z} m ahead`);
  assert.equal(g.pose, 'swing');
});

test('releasing before the web lands cancels it: nothing attaches, no miss line', () => {
  const g = createGame(1);
  walls(g);
  stepGame(g, DT, [shot('R', 'mid')]);
  assert.ok(g.web && g.web.hit);
  const ev = stepGame(g, DT, [REL]);
  assert.ok(!ev.includes('released'));
  assert.equal(g.web, null);
  for (let t = 0; t < 1; t += DT) stepGame(g, DT, []);
  assert.equal(g.player.anchor, null);
  assert.equal(g.missLine, null);
});

test('no teleport: every frame the hero moves no farther than its speed allows', () => {
  for (const level of ['hi', 'mid', 'lo']) for (const seed of [1, 2, 3]) {
    const g = createGame(seed);
    let acts = [shot(seed % 2 ? 'R' : 'L', level)];
    let attachedFor = 0;
    for (let i = 0; i < 240 && g.player.alive; i++) {
      const p = g.player, prev = { ...p.pos }, v0 = speed(p.vel);
      stepGame(g, DT, acts);
      acts = [];
      const step = Math.hypot(p.pos.x - prev.x, p.pos.y - prev.y, p.pos.z - prev.z);
      const bound = (Math.max(v0, speed(p.vel)) + CFG.gravity * DT) * DT + 1e-6;
      assert.ok(step <= bound, `${level} seed ${seed} frame ${i}: moved ${step.toFixed(3)} > ${bound.toFixed(3)}`);
      if (p.anchor) attachedFor++;
    }
    assert.ok(attachedFor > 60, `${level} seed ${seed}: attached only ${attachedFor} frames`);
  }
});

// The old build went 22 -> 32 m/s within 1.5 s (gravity 18, a 25 m/s reel, a forward-speed floor).
test('the first swing is gentle: speed builds at about g, not faster, from a slow start', () => {
  const g = createGame(1);
  stepGame(g, DT, [shot('L', 'hi')]);
  let prev = speed(g.player.vel), peak = prev;
  for (let i = 1; i <= 180; i++) {
    const ev = stepGame(g, DT, []);
    const v = speed(g.player.vel);
    if (!ev.includes('bounce')) assert.ok(v - prev <= CFG.gravity * DT * 1.1, `frame ${i}: +${((v - prev) / DT).toFixed(1)} m/s^2`);
    if (i === 60) assert.ok(v < 18, `${v.toFixed(1)} m/s after 1 s`);
    peak = Math.max(peak, v);
    prev = v;
  }
  assert.ok(peak < 34, `first swing peaked at ${peak.toFixed(1)} m/s`);
});

test('holding keeps the rope 5+ s: no auto-release, the rope only shortens', () => {
  const g = createGame(1);
  walls(g);
  stepGame(g, DT, [shot('R', 'hi')]);
  fly(g);
  const a = g.player.anchor;
  assert.ok(a);
  let len = g.player.ropeLen;
  for (let t = 0; t < 5.5; t += DT) {
    assert.ok(!stepGame(g, DT, []).includes('released'));
    assert.ok(g.player.ropeLen <= len + 1e-9);
    len = g.player.ropeLen;
  }
  assert.deepEqual(g.player.anchor, a);
});

test('release keeps the swing velocity: no boost, no drop, only gravity and drag for the frame', () => {
  for (const seed of [1, 2, 3, 4]) {
    const g = createGame(seed);
    walls(g);
    stepGame(g, DT, [shot(seed % 2 ? 'R' : 'L', 'hi')]);
    assert.ok(swingUntilClimb(g), `seed ${seed}: swing never climbed`);
    const v = { ...g.player.vel };
    const ev = stepGame(g, DT, [REL]);
    assert.ok(ev.includes('released'));
    assert.equal(g.player.anchor, null);
    const after = g.player.vel, drag = CFG.airDrag * speed(v) ** 2 * DT;
    assert.ok(Math.abs(after.y - (v.y - CFG.gravity * DT)) <= drag + 0.02, `seed ${seed}: vy ${v.y} -> ${after.y}`);
    assert.ok(Math.abs(after.x - v.x) <= drag + 0.02 && Math.abs(after.z - v.z) <= drag + 0.02, `seed ${seed}: horizontal changed`);
    // a real fling: still rising a while later, still moving forward as fast
    for (let t = 0; t < 0.3; t += DT) stepGame(g, DT, []);
    assert.ok(g.player.vel.y > 0, `seed ${seed}: dropped right after release`);
    assert.ok(g.player.vel.z > v.z * 0.9);
  }
});

test('a release with no rope does nothing', () => {
  const g = createGame(1);
  course(g, []);
  stepGame(g, DT, [shot('L', 'hi')]);
  fly(g);
  assert.equal(g.player.anchor, null);
  const v = { ...g.player.vel };
  const ev = stepGame(g, DT, [REL]);
  assert.ok(!ev.includes('released'));
  assert.ok(Math.abs(g.player.vel.y - (v.y - CFG.gravity * DT)) < 0.01);
  assert.equal(g.pose, 'glide');
});

test('a new press while attached replaces the rope (last pressed wins)', () => {
  const g = createGame(1);
  walls(g);
  stepGame(g, DT, [shot('R', 'hi')]);
  fly(g);
  const a = g.player.anchor;
  stepGame(g, DT, [shot('L', 'hi')]);
  assert.deepEqual(g.player.anchor, a); // the old rope holds while the new web flies
  fly(g);
  assert.ok(g.player.anchor && g.player.anchor.x < 0 && a.x > 0);
  assert.equal(g.phys.world.constraints.length, 1);
});

test('a miss shows a missLine that expires after missShowSec', () => {
  const g = createGame(1);
  course(g, []);
  stepGame(g, DT, [shot('L', 'hi')]);
  assert.equal(g.missLine, null); // shown only when the web reaches full range
  fly(g);
  assert.equal(g.player.anchor, null);
  assert.ok(g.missLine && g.missLine.to.x < 0);
  for (let t = 0; t <= CFG.missShowSec; t += DT) stepGame(g, DT, []);
  assert.equal(g.missLine, null);
});

test('webs: frames refuse them, the open middle lets them through, cranes and skybridges hold', () => {
  const g = createGame(1);
  const frame = [
    block('F:post0', 'frame', { x: W, y: 0, z: 40 }, { x: W + 1.6, y: 62, z: 41.6 }),
    block('F:beam0', 'frame', { x: W, y: 60, z: 40 }, { x: W + 1.6, y: 62, z: 70 }),
  ];
  course(g, [...frame, block('B:base', 'tower', { x: W + 10, y: 0, z: 0 }, { x: W + 30, y: 120, z: 300 })]);
  stepGame(g, DT, [shot('R', 'mid')]);
  assert.ok(g.web.hit && Math.abs(g.web.to.x - W - 10) < 1e-6, 'through the frame onto the tower behind');
  const g2 = createGame(1);
  const y = g2.player.pos.y + CFG.render.playerHand;
  course(g2, [block('B1:bridge', 'bridge', { x: -W - 2, y: y + 8, z: 40 }, { x: W + 2, y: y + 13, z: 45 })]);
  stepGame(g2, DT, [shot('R', 'hi')]);
  assert.ok(g2.web.hit && Math.abs(g2.web.to.z - 40) < 1e-6, 'hi web sticks to the skybridge');
  const g3 = createGame(1);
  course(g3, [block('C1:mast', 'crane', { x: 17, y: 0, z: 62 }, { x: 20, y: 90, z: 66 })]);
  stepGame(g3, DT, [shot('R', 'mid')]);
  assert.ok(g3.web.hit && Math.abs(g3.web.to.x - 17) < 1e-6, 'mid web sticks to the crane mast');
  const g4 = createGame(1);
  course(g4, frame);
  stepGame(g4, DT, [shot('R', 'mid')]);
  assert.ok(!g4.web.hit, 'nothing behind the frame: a miss');
});

test('too-short rope (attach refuses) counts as a miss', () => {
  const g = createGame(1);
  g.phys.hero.position.x = g.player.pos.x = W - 0.6; // hugging the right wall: a lo web hits it ~2 m away
  course(g, [tower('W9', 1, -50, 2.5, 200)]);
  stepGame(g, DT, [shot('R', 'lo')]);
  fly(g);
  assert.equal(g.player.anchor, null);
  assert.ok(g.missLine);
});

test('release plays a trick pose for trickSec, then glide', () => {
  const g = createGame(1);
  walls(g);
  stepGame(g, DT, [shot('R', 'hi')]);
  swingUntilClimb(g);
  assert.ok(stepGame(g, DT, [REL]).includes('released'));
  assert.ok(CFG.character.tricks.includes(g.pose));
  for (let t = 0; t < CFG.trickSec + DT; t += DT) stepGame(g, DT, []);
  if (!g.player.anchor && g.player.alive) assert.equal(g.pose, 'glide');
});

test('shake kicks in at the swing bottom and decays', () => {
  const g = createGame(1);
  walls(g);
  stepGame(g, DT, [shot('R', 'hi')]);
  fly(g);
  assert.ok(g.player.anchor);
  let peak = 0;
  for (let i = 0; i < 300; i++) { stepGame(g, DT, []); peak = Math.max(peak, g.shake); }
  assert.equal(peak, CFG.render.shakePeak);
  g.player.alive = false; // isolate the decay itself
  for (let i = 0; i < 120; i++) stepGame(g, DT, []);
  assert.ok(g.shake < peak * 0.1);
});

test('never firing dies within 10 s on every seed; one dead event; the body then rests on the street', () => {
  for (const seed of [7, 8, 9, 10, 11, 12, 13, 14]) {
    const g = createGame(seed);
    let deaths = 0, t = 0;
    for (; t < 10 && g.player.alive; t += DT) deaths += stepGame(g, DT, []).filter((e) => e === 'dead').length;
    assert.equal(g.player.alive, false, `seed ${seed}`);
    assert.ok(t < 10);
    const pos = { ...g.player.pos };
    for (let i = 0; i < 60; i++) deaths += stepGame(g, DT, []).filter((e) => e === 'dead').length;
    assert.equal(deaths, 1);
    stepGame(g, DT, [shot('R', 'mid')]); // shots after death do nothing
    assert.equal(g.player.anchor, null);
    assert.deepEqual(g.player.pos, pos);
    assert.ok(pos.y < CFG.heroRadius + 0.06);
    assert.equal(g.pose, 'fall');
  }
});

// Solid structures: the hero's centre is never inside any box, whatever the bot does (many wall hits).
test('solid: across 10 bot runs of 30 s the hero never ends a frame inside a structure', () => {
  for (let seed = 201; seed <= 210; seed++) {
    const g = createGame(seed), bot = createBot();
    for (let t = 0; t < 30 && g.player.alive; t += DT) {
      stepGame(g, DT, bot(g, DT));
      const p = g.player.pos;
      for (const s of g.world.structures) {
        const inside = ['x', 'y', 'z'].every((k) => p[k] > s.min[k] && p[k] < s.max[k]);
        assert.ok(!inside, `seed ${seed} t=${t.toFixed(2)}: inside ${s.id}`);
      }
    }
  }
});

test('deterministic: the same seed and inputs replay exactly', () => {
  const run = () => {
    const g = createGame(9), bot = createBot();
    for (let t = 0; t < 10; t += DT) stepGame(g, DT, bot(g, DT));
    return { ...g.player.pos };
  };
  assert.deepEqual(run(), run());
});

test('pickTrickPose returns only trick poses and covers all of them', () => {
  const rng = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickTrickPose(rng));
  assert.deepEqual([...seen].sort(), ['glide', 'roll', 'tuck']);
});

// CFG was tuned on seeds 41-100 (and checked on 101-200), not only these.
test('bot (best holdable aim, let go on the climb) survives 30 s on >= 90% of seeds 1-40', () => {
  const dead = [];
  for (let seed = 1; seed <= 40; seed++) {
    const g = createGame(seed);
    const bot = createBot();
    let t = 0;
    for (; t < 30 && g.player.alive; t += DT) stepGame(g, DT, bot(g, DT));
    if (!g.player.alive) dead.push(`${seed}@${t.toFixed(1)}s`);
  }
  assert.ok(dead.length <= 4, `died: ${dead.join(' ')}`);
});

test('huge dt is clamped to maxDt (tab switch is not instant death)', () => {
  const g = createGame(1);
  stepGame(g, 5, []);
  assert.equal(g.player.alive, true);
  assert.ok(g.elapsed <= CFG.maxDt + 1e-12);
});

test('a shot casts from the hand (pos.y + playerHand)', () => {
  const g = createGame(1);
  course(g, []);
  const y0 = g.player.pos.y;
  stepGame(g, 0.0001, [shot('R', 'mid')]);
  assert.ok(Math.abs(g.web.to.y - (y0 + CFG.render.playerHand)) < 1e-6); // mid aims level
});
