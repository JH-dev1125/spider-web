import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, createBot } from '../src/game.js';

const DT = 1 / 60;
const shot = (side, level, heldSec = CFG.chargeFullSec) => ({ side, level, heldSec });

test('createGame: populated world, live player, glide pose', () => {
  const g = createGame(1);
  assert.ok(g.world.buildings.length > 0);
  assert.equal(g.player.alive, true);
  assert.equal(g.pose, 'glide');
  assert.equal(g.missLine, null);
});

test('a hitting shot attaches and switches to the swing pose', () => {
  const g = createGame(1);
  stepGame(g, DT, [shot('R', 'mid')]);
  assert.ok(g.player.anchor);
  assert.equal(g.pose, 'swing');
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
  stepGame(g, DT, [shot('R', 'mid', 0)]);
  assert.equal(g.player.anchor, null);
  assert.ok(g.missLine);
});

test('release plays a trick pose for trickSec, then glide', () => {
  const g = createGame(3);
  stepGame(g, DT, [shot('R', 'mid')]);
  let released = false;
  for (let i = 0; i < 600 && !released; i++) released = stepGame(g, DT, []).includes('released');
  assert.ok(released);
  assert.ok(CFG.character.tricks.includes(g.pose));
  for (let t = 0; t < CFG.trickSec + DT; t += DT) stepGame(g, DT, []);
  if (!g.player.anchor && g.player.alive) assert.equal(g.pose, 'glide');
});

test('shake kicks in at the swing bottom and decays', () => {
  const g = createGame(1);
  stepGame(g, DT, [shot('R', 'mid')]);
  assert.ok(g.player.anchor);
  let peak = 0;
  for (let i = 0; i < 300 && g.player.anchor; i++) { stepGame(g, DT, []); peak = Math.max(peak, g.shake); }
  assert.equal(peak, CFG.render.shakePeak);
  for (let i = 0; i < 120; i++) stepGame(g, DT, []);
  assert.ok(g.shake < peak * 0.1);
});

test('never firing dies within 10 s; one dead event; the body then rests on the street', () => {
  const g = createGame(7);
  let deaths = 0, t = 0;
  for (; t < 10 && g.player.alive; t += DT) deaths += stepGame(g, DT, []).filter((e) => e === 'dead').length;
  assert.equal(g.player.alive, false);
  assert.ok(t < 10);
  for (let i = 0; i < 60; i++) deaths += stepGame(g, DT, []).filter((e) => e === 'dead').length;
  assert.equal(deaths, 1);
  const z = g.player.pos.z;
  stepGame(g, DT, [shot('R', 'mid')]); // shots after death do nothing
  assert.equal(g.player.anchor, null);
  assert.equal(g.player.pos.y, 0); // resting on the street, not sliding on or sinking
  assert.equal(g.player.pos.z, z);
  assert.equal(g.pose, 'fall');
});

// The bot is blind (it alternates even when sliding on a wall), so a few seeds still lose; require 90%.
test('bot firing R/L hi alternately with ~0.6 s charge survives 30 s on >= 90% of 40 seeds', () => {
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
