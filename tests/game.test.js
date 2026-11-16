import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, createBot, aim, startGame } from '../src/game.js';
import { placeHero } from '../src/player.js';
import { MOVES, FLIGHT } from '../src/moves.js';
import { makeRng } from '../src/world.js';
import { aimVector } from '../src/web.js';

const DT = 1 / 60;
const W = CFG.corridorHalfWidth;
const comVel = g => ({ ...g.player.vel }); // the core: the gameplay body
const place = (g, pos, vel) => placeHero(g.phys, g.player, pos, vel);
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
  assert.equal(g.phys.world.constraints.length, 1); // one rope on the core
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
    block('F:post0', 'frame', { x: W, y: 0, z: 20 }, { x: W + 1.6, y: 202, z: 21.6 }), // the web meets x = W at z ~40,
    block('F:beam0', 'frame', { x: W, y: 200, z: 20 }, { x: W + 1.6, y: 202, z: 70 }), // between the post and under the beam
  ];
  course(g, [...frame, block('B:base', 'tower', { x: W + 10, y: 0, z: 0 }, { x: W + 30, y: 300, z: 300 })]);
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

test('release: the release flourish, then the flight chain (FLIGHT links); a press cancels it at once', () => {
  const g = createGame(1);
  walls(g);
  stepGame(g, DT, [shot('R', 'hi')]);
  swingUntilClimb(g, 0.4); // before the swing reaches the wall (a wall run would show 'wallrun')
  assert.ok(stepGame(g, DT, [REL]).includes('released'));
  assert.equal(g.phys.motion.move, MOVES.release);
  for (let t = 0; t <= MOVES.release.duration + 2 * DT; t += DT) stepGame(g, DT, []);
  assert.equal(g.phys.motion, null);
  assert.ok(FLIGHT[g.phys.flightMove], `a flight link follows the release (${g.phys.flightMove})`);
  stepGame(g, DT, [shot('L', 'lo')]); // even a miss cancels it (he aims the web instead)
  assert.ok(!FLIGHT[g.phys.flightMove], g.phys.flightMove);
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

test('never firing dies within 10 s; one death; the hero landing holds on the street', () => {
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
    assert.ok(g.player.pos.y < 1, 'down at street level');
    assert.ok(Object.values(g.player.pos).every(Number.isFinite));
    assert.equal(g.pose, 'landing');
    assert.equal(g.phys.motion?.move, MOVES.landing, 'muscles hold the landing pose');
  }
});

// Solid structures: the hero's centre is never inside any box, whatever the bot does (many wall hits).
test('solid: across 10 bot runs of 30 s the hero never ends a frame inside a structure', () => {
  for (let seed = 201; seed <= 210; seed++) {
    const g = createGame(seed, { rig: false }), bot = createBot();
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
    const g = createGame(9), bot = createBot(); // (with the follower: it never feeds back)
    for (let t = 0; t < 10; t += DT) stepGame(g, DT, bot(g, DT));
    return { ...g.player.pos };
  };
  assert.deepEqual(run(), run());
});


// Bot decisions are tuned on seeds 41-50; this is the held-out acceptance range.
test('bot (best holdable aim, let go on the climb) survives 30 s on >= 90% of seeds 1-40', t => {
  const dead = [];
  for (let seed = 1; seed <= 40; seed++) {
    const g = createGame(seed, { rig: false }); // the core alone: the follower never changes it (core.test.js)
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

test('a shot casts from the core\'s shoulder on that side (gameplay never reads the follower)', () => {
  const g = createGame(1);
  course(g, []);
  const y0 = g.player.pos.y + CFG.webShoulder.y;
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

const rigMomentum = (g) => ({ x: CFG.heroMass * g.player.vel.x, y: CFG.heroMass * g.player.vel.y, z: CFG.heroMass * g.player.vel.z });
const rigMass = () => CFG.heroMass;

test('zip = slingshot: the rope is gone the same frame, ~zipLaunch m/s ahead (tilted toward the rope) over zipLaunchSteps, then a cooldown', () => {
  for (const [seed, side, level] of [[1, 'R', 'hi'], [2, 'L', 'mid'], [3, 'R', 'mid']]) {
    const a = attached(seed, side, level), b = attached(seed, side, level);
    const ev = stepGame(a, DT, [ZIP]);
    assert.ok(ev.includes('released') && ev.includes('zipped'), ev.join());
    assert.equal(a.player.anchor, null, 'no rope after the zip frame');
    assert.equal(a.phys.rope, null);
    assert.equal(a.phys.world.constraints.length, 0, 'no hidden rope');
    stepGame(b, DT, [REL]); // the same frame without the launch
    for (let i = 0; i < 2; i++) { stepGame(a, DT, []); stepGame(b, DT, []); } // all zipLaunchSteps delivered
    const M = rigMass(a), pa = rigMomentum(a), pb = rigMomentum(b);
    const dv = { x: (pa.x - pb.x) / M, y: (pa.y - pb.y) / M, z: (pa.z - pb.z) / M };
    assert.ok(Math.abs(speed(dv) - CFG.zipLaunch) < 2, `seed ${seed}: +${speed(dv).toFixed(1)} m/s`);
    assert.ok(dv.z > 0.8 * speed(dv), `seed ${seed}: mostly ahead`);
    assert.ok(dv.y >= -0.5, `seed ${seed}: never down`);
    assert.ok(a.phys.zipCooldown > 0 && a.phys.motion?.move === MOVES.zipYank);
  }
  // the cooldown: a fresh rope right after cannot zip again yet
  const g = attached();
  stepGame(g, DT, [ZIP]);
  stepGame(g, DT, [shot('R', 'hi')]); fly(g);
  if (g.player.anchor && g.phys.zipCooldown > 0) assert.ok(!stepGame(g, DT, [ZIP]).includes('zipped'), 'cooldown');
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

test('W: a web straight ahead and up lands on a crane jib over the street and swings the hero under it', () => {
  const g = createGame(1);
  const hand = { x: g.player.pos.x, y: g.player.pos.y + CFG.webShoulder.y, z: g.player.pos.z }, jibY = hand.y + 30;
  const zc = hand.z + (jibY - hand.y) / Math.tan(CFG.aimUpDeg.mid * Math.PI / 180), z0 = zc - 1.5, z1 = zc + 1.5; // where the W web meets the jib
  course(g, [
    block('K:mast', 'crane', { x: W + 3, y: 0, z: z0 }, { x: W + 6, y: jibY, z: z1 }),
    block('K:jib', 'crane', { x: -10, y: jibY, z: z0 }, { x: W + 14, y: jibY + 3, z: z1 }),
  ]);
  stepGame(g, DT, []); // syncs the physics boxes
  const a = aim(g, 'C', 'mid');
  assert.ok(a.hit, 'W aims at the jib');
  assert.ok(Math.abs(a.to.y - jibY) < 1e-6 && a.to.z > z0 - 1e-6 && a.to.z < z1 + 1e-6, `hit ${JSON.stringify(a.to)}`);
  stepGame(g, DT, [shot('C', 'mid')]);
  fly(g);
  assert.ok(g.player.anchor && Math.abs(g.player.anchor.y - jibY) < 1e-6, 'attached to the jib');
  assert.equal(g.pose, 'swing');
  assert.ok(!aim(g, 'L', 'mid').hit && !aim(g, 'R', 'mid').hit, 'the side webs find nothing here: only W does');
});
