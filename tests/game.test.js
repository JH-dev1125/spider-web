import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, createBot, pickTrickPose } from '../src/game.js';
import { aimVector, castWeb } from '../src/web.js';
import { makeRng } from '../src/world.js';

const DT = 1 / 60;
const shot = (side, level) => ({ type: 'press', side, level });
const REL = { type: 'release' };
// Hold until `sec` past the swing bottom, then let go. Returns the release frame's events.
function swingAndLetGo(g, sec = 0.2) {
  let after = 0;
  for (let i = 0; i < 600 && g.player.anchor && after < sec; i++) {
    stepGame(g, DT, []);
    if (g.player.swingPhase === 'ascending') after += DT;
  }
  return stepGame(g, DT, [REL]);
}

test('createGame: populated world, live player, glide pose', () => {
  const g = createGame(1);
  assert.ok(g.world.buildings.length > 0);
  assert.equal(g.player.alive, true);
  assert.equal(g.pose, 'glide');
  assert.equal(g.missLine, null);
});

test('a press attaches in the same frame and switches to the swing pose', () => {
  const g = createGame(1);
  stepGame(g, DT, [shot('R', 'mid')]);
  assert.ok(g.player.anchor);
  assert.equal(g.pose, 'swing');
});

test('holding keeps the rope 5+ s: no auto-release', () => {
  const g = createGame(1);
  stepGame(g, DT, [shot('R', 'hi')]);
  const a = g.player.anchor;
  assert.ok(a);
  for (let t = 0; t < 5.5; t += DT) assert.ok(!stepGame(g, DT, []).includes('released'));
  assert.deepEqual(g.player.anchor, a);
});

test('release detaches with the boost and emits released', () => {
  const g = createGame(1);
  stepGame(g, DT, [shot('R', 'hi')]);
  let after = 0;
  for (let i = 0; i < 600 && after < 0.2; i++) { stepGame(g, DT, []); if (g.player.swingPhase === 'ascending') after += DT; }
  const vy = g.player.vel.y;
  const ev = stepGame(g, DT, [REL]);
  assert.ok(ev.includes('released'));
  assert.equal(g.player.anchor, null);
  // boost minus one frame of gravity
  assert.ok(Math.abs(g.player.vel.y - (vy + CFG.releaseBoostUp - CFG.gravity * DT)) < 1e-6);
});

test('a release after a miss (or with no rope) does nothing', () => {
  const g = createGame(1);
  g.world.buildings = [];
  g.world.nextZ = { L: Infinity, R: Infinity };
  stepGame(g, DT, [shot('L', 'hi')]);
  assert.equal(g.player.anchor, null);
  const v = { ...g.player.vel };
  const ev = stepGame(g, DT, [REL]);
  assert.ok(!ev.includes('released'));
  assert.ok(Math.abs(g.player.vel.y - (v.y - CFG.gravity * DT)) < 1e-9); // gravity only, no boost
  assert.equal(g.pose, 'glide');
});

test('a new press while attached replaces the rope (last pressed wins)', () => {
  const g = createGame(1);
  g.world.buildings = ['L', 'R'].map((side) => ({ side, z0: 0, z1: 300, h: 100 }));
  g.world.nextZ = { L: Infinity, R: Infinity };
  stepGame(g, DT, [shot('R', 'hi')]);
  const a = g.player.anchor;
  stepGame(g, DT, [shot('L', 'hi')]);
  assert.ok(g.player.anchor && g.player.anchor.x < 0 && a.x > 0);
});

test('a miss shows a missLine that expires after missShowSec', () => {
  const g = createGame(1);
  g.world.buildings = [];
  g.world.nextZ = { L: Infinity, R: Infinity }; // keep the corridor empty
  stepGame(g, DT, [shot('L', 'hi')]);
  assert.equal(g.player.anchor, null);
  assert.ok(g.missLine && g.missLine.to.x < 0);
  for (let t = 0; t <= CFG.missShowSec; t += DT) stepGame(g, DT, []);
  assert.equal(g.missLine, null);
});

test('too-short rope (attach refuses) counts as a miss', () => {
  const g = createGame(1);
  g.player.pos.x = CFG.corridorHalfWidth - 1; // hugging the right wall
  stepGame(g, DT, [shot('R', 'mid')]);
  assert.equal(g.player.anchor, null);
  assert.ok(g.missLine);
});

test('release plays a trick pose for trickSec, then glide', () => {
  const g = createGame(3);
  stepGame(g, DT, [shot('R', 'mid')]);
  assert.ok(swingAndLetGo(g).includes('released'));
  assert.ok(CFG.character.tricks.includes(g.pose));
  for (let t = 0; t < CFG.trickSec + DT; t += DT) stepGame(g, DT, []);
  if (!g.player.anchor && g.player.alive) assert.equal(g.pose, 'glide');
});

test('shake kicks in at the swing bottom and decays', () => {
  const g = createGame(1);
  stepGame(g, DT, [shot('R', 'mid')]);
  assert.ok(g.player.anchor);
  let peak = 0;
  for (let i = 0; i < 300; i++) { stepGame(g, DT, []); peak = Math.max(peak, g.shake); }
  assert.equal(peak, CFG.render.shakePeak);
  g.player.alive = false; // no further bounces: isolate the decay itself
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
    for (let i = 0; i < 60; i++) deaths += stepGame(g, DT, []).filter((e) => e === 'dead').length;
    assert.equal(deaths, 1);
    const z = g.player.pos.z;
    stepGame(g, DT, [shot('R', 'mid')]); // shots after death do nothing
    assert.equal(g.player.anchor, null);
    assert.equal(g.player.pos.y, 0); // resting on the street, not sliding on or sinking
    assert.equal(g.player.pos.z, z);
    assert.equal(g.pose, 'fall');
  }
});

// Spec 1.1: choosing which building matters, so a swing must not leave the same-side wall unusable.
// Before the wall push-off ~20% of swings glued the player to the face (every same-side web too short).
test('after a swing on side S, a same-side web becomes attachable within 1 s on >= 95% of seeds', () => {
  const sameSideOk = (g, side) => ['hi', 'mid', 'lo'].some((lv) => {
    const p = g.player;
    const hit = castWeb(p.pos, aimVector(side, lv), CFG.webRange, g.world.buildings);
    return hit && Math.hypot(hit.x - p.pos.x, hit.y - p.pos.y, hit.z - p.pos.z) >= CFG.minRopeLen;
  });
  for (const level of ['mid', 'hi']) {
    let n = 0, ok = 0;
    for (let seed = 101; seed <= 140; seed++) {
      const side = seed % 2 ? 'R' : 'L';
      const g = createGame(seed);
      for (let t = 0; t < CFG.botWaitSec; t += DT) stepGame(g, DT, []);
      stepGame(g, DT, [shot(side, level)]);
      if (!g.player.anchor) continue;
      if (!swingAndLetGo(g, CFG.botHoldAfterBottomSec).includes('released') || !g.player.alive) continue;
      n++;
      let can = false;
      for (let t = 0; t < 1 && g.player.alive && !can; t += DT) { can = sameSideOk(g, side); stepGame(g, DT, []); }
      if (can) ok++;
    }
    assert.ok(n >= 25, `${level}: only ${n} swings completed`);
    assert.ok(ok >= n * 0.95, `${level}: same-side attach possible on ${ok}/${n}`);
  }
});

test('pickTrickPose returns only trick poses and covers all of them', () => {
  const rng = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickTrickPose(rng));
  assert.deepEqual([...seen].sort(), ['glide', 'roll', 'tuck']);
});

// The bot is blind (it alternates even when sliding on a wall), so a few seeds may lose; require 90%.
// CFG was tuned on seeds 1001-1040, not these.
test('bot pressing R/L hi alternately, letting go just past the bottom, survives 30 s on >= 90% of 40 seeds', () => {
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
  g.world.buildings = [];
  g.world.nextZ = { L: Infinity, R: Infinity };
  const y0 = g.player.pos.y;
  stepGame(g, 0.0001, [shot('R', 'mid')]);
  assert.ok(Math.abs(g.missLine.to.y - (y0 + CFG.render.playerHand)) < 1);
});
