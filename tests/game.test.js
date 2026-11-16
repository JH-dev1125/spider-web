import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, createBot, pickTrickPose } from '../src/game.js';
import { setZip } from '../src/player.js';
import { makeRng } from '../src/world.js';
import { aimVector } from '../src/web.js';

const DT = 1 / 60;
const W = CFG.corridorHalfWidth;
const comVel = g => Object.values(g.phys.rag.bodies).reduce((v,b)=>({x:v.x+b.velocity.x*b.mass/CFG.heroMass,y:v.y+b.velocity.y*b.mass/CFG.heroMass,z:v.z+b.velocity.z*b.mass/CFG.heroMass}),{x:0,y:0,z:0});
function place(g, pos, vel) {
  const d = {x:pos.x-g.phys.hero.position.x,y:pos.y-g.phys.hero.position.y,z:pos.z-g.phys.hero.position.z};
  for(const b of Object.values(g.phys.rag.bodies)) {b.position.x+=d.x;b.position.y+=d.y;b.position.z+=d.z;b.velocity.set(vel.x,vel.y,vel.z);b.aabbNeedsUpdate=true;}
  Object.assign(g.player.pos,pos);Object.assign(g.player.vel,vel);
}
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
  g.world.fixed = true;
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
  assert.deepEqual(w.from, { ...g.phys.rag.bodies.handR.position }); // follows the hand
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

test('no teleport: all pelvis movement is integrated by the engine, including collision substeps', () => {
  for (const level of ['hi','mid','lo']) for (const seed of [1,2,3]) {
    const g=createGame(seed), h=CFG.physicsStep, engineStep=g.phys.world.step.bind(g.phys.world);
    let last={...g.player.pos};
    g.phys.world.step=dt=>{
      const prev={...g.phys.hero.position};engineStep(dt);
      for(const k of ['x','y','z']) assert.ok(Math.abs(g.phys.hero.position[k]-prev[k]-g.phys.hero.velocity[k]*dt)<1e-7,level+' '+k);
      last={...g.phys.hero.position};
    };
    for(let i=0;i<480&&g.player.alive;i++) {
      stepGame(g,h,i===0?[shot('R',level)]:[]);
      assert.deepEqual(g.player.pos,last);
    }
  }
});

// The old build went 22 -> 32 m/s within 1.5 s (gravity 18, a 25 m/s reel, a forward-speed floor).
test('the first swing is gentle: whole-body speed stays gentle despite joint reactions', () => {
  const g = createGame(1);
  stepGame(g, DT, [shot('L', 'hi')]);
  let prev = speed(comVel(g)), peak = prev;
  for (let i = 1; i <= 180; i++) {
    const ev = stepGame(g, DT, []);
    const v = speed(comVel(g));
    if (!ev.includes('bounce') && !g.player.wall) assert.ok(v - prev <= CFG.gravity * DT * 2, `frame ${i}: +${((v - prev) / DT).toFixed(1)} m/s^2`);
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
    // climb 0.4: let go before the swing carries him into the anchor's wall (that would start a wall run)
    assert.ok(swingUntilClimb(g, 0.4), `seed ${seed}: swing never climbed`);
    const v = comVel(g);
    const ev = stepGame(g, DT, [REL]);
    assert.ok(ev.includes('released'));
    assert.equal(g.player.anchor, null);
    const after = comVel(g), drag = CFG.airDrag * speed(v) ** 2 * DT;
    assert.ok(Math.abs(after.y - (v.y - CFG.gravity * DT)) <= drag + 0.02, `seed ${seed}: vy ${v.y} -> ${after.y}`);
    assert.ok(Math.abs(after.x - v.x) <= drag + 0.02 && Math.abs(after.z - v.z) <= drag + 0.02, `seed ${seed}: horizontal changed`);
    // a real fling: still rising a while later, still moving forward as fast
    let hit = false;
    for (let t = 0; t < 0.3; t += DT) hit = stepGame(g, DT, []).some(e=>e==='bounce'||e.startsWith('wall')) || hit;
    assert.ok(comVel(g).y > 0, `seed ${seed}: dropped right after release`);
    if (!hit) assert.ok(comVel(g).z > v.z * 0.9);
  }
});

test('a release with no rope does nothing', () => {
  const g = createGame(1);
  course(g, []);
  stepGame(g, DT, [shot('L', 'hi')]);
  fly(g);
  assert.equal(g.player.anchor, null);
  const v = comVel(g);
  const ev = stepGame(g, DT, [REL]);
  assert.ok(!ev.includes('released'));
  assert.ok(Math.abs(comVel(g).y - (v.y - CFG.gravity * DT)) < 0.03);
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
  assert.equal(g.phys.world.constraints.length, 15);
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
  const hand2 = g2.phys.rag.bodies.handR.position;
  const hi = aimVector('R', 'hi', g2.player.pos.x), yb = hand2.y + hi.y * ((40 - hand2.z) / hi.z); // where the hi web crosses z = 40
  course(g2, [block('B1:bridge', 'bridge', { x: -W - 2, y: yb - 2, z: 40 }, { x: W + 2, y: yb + 3, z: 45 })]);
  stepGame(g2, DT, [shot('R', 'hi')]);
  assert.ok(g2.web.hit && Math.abs(g2.web.to.z - 40) < 1e-6, 'hi web sticks to the skybridge');
  const g3 = createGame(1);
  const mid = aimVector('R', 'mid', 0), zm = 17 * mid.z / mid.x; // where the mid web reaches x = 17
  course(g3, [block('C1:mast', 'crane', { x: 17, y: 0, z: zm - 2 }, { x: 20, y: 200, z: zm + 2 })]);
  stepGame(g3, DT, [shot('R', 'mid')]);
  assert.ok(g3.web.hit && Math.abs(g3.web.to.x - 17) < 1e-6, 'mid web sticks to the crane mast');
  const g4 = createGame(1);
  course(g4, frame);
  stepGame(g4, DT, [shot('R', 'mid')]);
  assert.ok(!g4.web.hit, 'nothing behind the frame: a miss');
});

test('too-short rope (attach refuses) counts as a miss', () => {
  const g = createGame(1);
  place(g,{x:W-.6,y:CFG.startHeight,z:0},{x:0,y:0,z:CFG.startSpeed}); // hugging the right wall: a lo web hits it ~2 m away
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
  swingUntilClimb(g, 0.4); // before the swing reaches the wall (a wall run would show 'wallrun')
  assert.ok(stepGame(g, DT, [REL]).includes('released'));
  assert.ok(CFG.character.tricks.includes(g.pose));
  let wall = false;
  for (let t = 0; t < CFG.trickSec + DT; t += DT) wall = stepGame(g, DT, []).some((e) => e.startsWith('wall')) || wall;
  if (!g.player.anchor && g.player.alive && !wall) assert.equal(g.pose, 'glide');
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

test('never firing dies within 10 s; one death; limp ragdoll continues settling on the street', () => {
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
    assert.ok(g.player.pos.y < 1, 'collapsed at street level');
    assert.ok(Object.values(g.player.pos).every(Number.isFinite));
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
        for(const b of Object.values(g.phys.rag.bodies)) assert.ok(!['x','y','z'].every(k=>b.position[k]>s.min[k]&&b.position[k]<s.max[k]), `seed ${seed} ${b.part} inside ${s.id}`);
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

// Bot decisions are tuned on seeds 41-50; this is the held-out acceptance range.
test('bot (best holdable aim, let go on the climb) survives 30 s on >= 90% of seeds 1-40', t => {
  const dead = [];
  for (let seed = 1; seed <= 40; seed++) {
    const g = createGame(seed);
    const bot = createBot();
    let t = 0;
    for (; t < 30 && g.player.alive; t += DT) stepGame(g, DT, bot(g, DT));
    if (!g.player.alive) dead.push(`${seed}@${t.toFixed(1)}s`);
  }
  t.diagnostic(`${40-dead.length}/40 survived; deaths: ${dead.join(' ') || 'none'}`);
  assert.ok(dead.length <= 4, `died: ${dead.join(' ')}`);
});

test('huge dt is clamped to maxDt (tab switch is not instant death)', () => {
  const g = createGame(1);
  stepGame(g, 5, []);
  assert.equal(g.player.alive, true);
  assert.ok(g.elapsed <= CFG.maxDt + 1e-12);
});

test('a shot casts from the actual hand rigid body', () => {
  const g = createGame(1);
  course(g, []);
  const y0 = g.phys.rag.bodies.handR.position.y;
  stepGame(g, 0.0001, [shot('R', 'mid')]);
  const dir = aimVector('R', 'mid', g.player.pos.x); // nothing to hit: the web ends at full range
  assert.ok(Math.abs(g.web.to.y - (y0 + dir.y * CFG.webRange)) < 1e-6);
});

// ---- zip (Space / hand pull): a snap, then a hard pull along the rope, auto-release near the anchor ----
const ZIP = { type: 'zip' };
const closingSpeed = (p) => {
  const d = { x: p.anchor.x - p.pos.x, y: p.anchor.y - p.pos.y, z: p.anchor.z - p.pos.z }, n = speed(d);
  return (d.x * p.vel.x + d.y * p.vel.y + d.z * p.vel.z) / n;
};
function attached(seed = 1, side = 'R', level = 'hi') {
  const g = createGame(seed);
  walls(g);
  stepGame(g, DT, [shot(side, level)]);
  fly(g);
  assert.ok(g.player.anchor);
  return g;
}

test('zip accelerates the hero toward the anchor, far harder than the plain swing', () => {
  const a = attached(), b = attached();
  const c0 = closingSpeed(a.player);
  stepGame(a, DT, [ZIP]);
  stepGame(b, DT, []);
  for (let i = 0; i < 20; i++) { stepGame(a, DT, []); stepGame(b, DT, []); }
  assert.ok(a.player.anchor, 'still pulling');
  const gain = closingSpeed(a.player) - c0, plain = closingSpeed(b.player) - c0;
  assert.ok(gain > CFG.zipAccel * 21 * DT * 0.7, `closing +${gain.toFixed(1)} m/s`);
  assert.ok(gain > plain + 10, `zip +${gain.toFixed(1)} vs swing +${plain.toFixed(1)}`);
  assert.ok(a.player.ropeLen < b.player.ropeLen - 2, 'the rope reels in faster');
});

test('zip auto-releases near the anchor, before passing it, and keeps all the momentum; no teleport, never inside a box', () => {
  for (const [seed, side, level] of [[1, 'R', 'hi'], [2, 'L', 'mid'], [3, 'R', 'mid']]) {
    const g = attached(seed, side, level), p = g.player, anchor = { ...p.anchor };
    const z0 = p.pos.z, d0 = speed({ x: anchor.x - p.pos.x, y: anchor.y - p.pos.y, z: anchor.z - p.pos.z });
    let ev = stepGame(g, DT, [ZIP]), i = 0;
    for (; i < 300 && p.anchor; i++) {
      const prev = { ...p.pos }, v0 = speed(p.vel);
      ev = stepGame(g, DT, []);
      const moved = Math.hypot(p.pos.x - prev.x, p.pos.y - prev.y, p.pos.z - prev.z);
      assert.ok(moved <= (Math.max(v0, speed(p.vel)) + CFG.zipAccel * DT) * DT + .02, `seed ${seed}: teleport`);
      for (const s of g.world.structures) assert.ok(!['x', 'y', 'z'].every((k) => p.pos[k] > s.min[k] && p.pos[k] < s.max[k]), `inside ${s.id}`);
    }
    assert.ok(!p.anchor && ev.includes('released') && ev.includes('zipped'), `seed ${seed}: no auto-release`);
    assert.ok(i * DT < 2.5, `seed ${seed}: took ${(i * DT).toFixed(2)} s`);
    const d = speed({ x: anchor.x - p.pos.x, y: anchor.y - p.pos.y, z: anchor.z - p.pos.z }), dz = anchor.z - p.pos.z;
    const frame = speed(p.vel) * DT; // a release lands within one frame of its threshold
    assert.ok(dz > 0, `seed ${seed}: passed the anchor (${dz.toFixed(1)} m)`);
    assert.ok(d < CFG.zipReleaseDist || dz < CFG.zipReleaseDist / 2 + frame, `seed ${seed}: let go ${d.toFixed(1)} m short`);
    // high webs: he draws level with the anchor's z while still below it, so it can let go well short, but not early
    assert.ok(d < 0.5 * d0, `seed ${seed}: let go far from the anchor (${d.toFixed(1)} of ${d0.toFixed(1)} m)`);
    assert.ok(p.pos.z > z0);
    // momentum: the next frame changes the velocity only by gravity and drag (unless he hits a wall)
    const v = comVel(g), sp = speed(v);
    assert.ok(sp > 20, `seed ${seed}: only ${sp.toFixed(1)} m/s after the zip`);
    const e2 = stepGame(g, DT, []);
    if (!e2.some((e) => e.startsWith('wall') || e === 'bounce')) {
      const drag = CFG.airDrag * sp * sp * DT;
      assert.ok(Math.abs(comVel(g).x - v.x) <= drag + 0.03 && Math.abs(comVel(g).z - v.z) <= drag + 0.03, `seed ${seed}: horizontal changed`);
      assert.ok(Math.abs(comVel(g).y - (v.y - CFG.gravity * DT)) <= drag + 0.03, `seed ${seed}: vy changed`);
    }
  }
});

test('zip snaps: the closing speed jumps by zipImpulse the instant it starts', () => {
  const g = attached(), c0 = closingSpeed(g.player);
  setZip(g.phys, true);
  const h = g.phys.hero.velocity;
  assert.ok(Math.abs(closingSpeed({ ...g.player, vel: { x: h.x, y: h.y, z: h.z } }) - c0 - CFG.zipImpulse) < 1e-9);
  setZip(g.phys, true); // already zipping: no second snap
  assert.ok(Math.abs(closingSpeed({ ...g.player, vel: { x: h.x, y: h.y, z: h.z } }) - c0 - CFG.zipImpulse) < 1e-9);
});

test('zipEnd stops the pull', () => {
  const a = attached(), b = attached();
  stepGame(a, DT, [ZIP]); stepGame(a, DT, [{ type: 'zipEnd' }]);
  stepGame(b, DT, []); stepGame(b, DT, []);
  const gap = closingSpeed(a.player) - closingSpeed(b.player);
  for (let i = 0; i < 30; i++) { stepGame(a, DT, []); stepGame(b, DT, []); }
  // one frame of pull = the snap (zipImpulse) plus one frame of zipAccel
  assert.ok(gap > CFG.zipImpulse * 0.9 && gap < CFG.zipImpulse + CFG.zipAccel * DT * 1.5, `one frame of pull: ${gap}`);
  assert.ok(closingSpeed(a.player) - closingSpeed(b.player) < gap + 2, 'no more pull after zipEnd');
});

test('zip without a rope does nothing', () => {
  const a = createGame(1), b = createGame(1);
  walls(a); walls(b);
  for (let i = 0; i < 30; i++) { stepGame(a, DT, i % 5 ? [] : [ZIP]); stepGame(b, DT, []); }
  assert.deepEqual(a.player.pos, b.player.pos);
  assert.deepEqual(a.player.vel, b.player.vel);
  // a web still in flight is not a rope either
  stepGame(a, DT, [shot('R', 'hi'), ZIP]); stepGame(b, DT, [shot('R', 'hi')]);
  fly(a); fly(b);
  for (let i = 0; i < 10; i++) { stepGame(a, DT, []); stepGame(b, DT, []); }
  assert.deepEqual(a.player.pos, b.player.pos);
});

test('wall run shows the wallrun pose, then walljump, then glide', () => {
  const g = createGame(1);
  walls(g);
  place(g,{x:11,y:60,z:0},{x:18,y:0,z:20});
  const poses = [];
  const frames = Math.ceil((1.5 + CFG.wallRunSec + CFG.trickSec) / DT); // reach the wall, run, jump, trick
  for (let i = 0; i < frames; i++) { stepGame(g, DT, []); poses.push(g.pose); }
  const r = poses.indexOf('wallrun'), j = poses.indexOf('walljump');
  assert.ok(Math.abs((j - r) * DT - CFG.wallRunSec) <= 2 * DT, `ran ${((j - r) * DT).toFixed(2)} s`); // the run ends in the jump
  assert.ok(r >= 0 && j > r, poses.join(' '));
  assert.ok(poses.slice(j).includes('glide'));
});

test('standing on a roof with no rope shows the run pose', () => {
  const g = createGame(1);
  const roof = block('RF:base', 'tower', { x: -10, y: 0, z: -5 }, { x: 10, y: 30, z: 200 });
  course(g, [roof]);
  place(g,{x:0,y:31.04,z:0},{x:0,y:0,z:0});
  const poses = [];
  for (let i = 0; i < 30; i++) { stepGame(g, DT, []); poses.push(g.pose); }
  assert.ok(g.player.roof && g.pose === 'run', poses.join(' '));
  assert.ok(g.player.pos.z > .1, 'contact stride advances on the roof');
});
