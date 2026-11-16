// The reference video's traversal beats: the start dive, the dive camera, the vertical wall run with its vault and
// perch, and the roof idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, startGame, createBot } from '../src/game.js';
import { createPlayer, placeHero } from '../src/player.js';
import { followCamera } from '../src/render-math.js';

const DT = 1 / 60, W = CFG.corridorHalfWidth;
const pitchOf = (from, to) => Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z)) * 180 / Math.PI;

test('start: on the roof edge facing the street, then a head-first dive (body pitch below -45 deg within 1 s), webbed out low', () => {
  const g = createGame(3, { start: 'roof' }), s = g.world.start;
  for (let i = 0; i < 60; i++) stepGame(g, DT, []);
  assert.equal(g.pose, 'idle');
  const cam = followCamera(g.player, null, DT, g.world.structures, g.street);
  assert.ok(pitchOf(cam, { x: cam.lx, y: cam.ly, z: cam.lz }) < -20, 'the edge camera looks down at the city');
  assert.ok(startGame(g));
  let pitch = 90;
  for (let i = 0; i < 60; i++) {
    stepGame(g, DT, []);
    const b = g.phys.rag.bodies;
    pitch = Math.min(pitch, pitchOf(b.pelvis.position, b.head.position));
  }
  assert.equal(g.pose, 'dive');
  assert.ok(pitch < -45, `body pitch ${pitch.toFixed(0)} deg`);
  const bot = createBot();
  let first = null;
  for (let i = 0; i < 60 * 20 && g.player.alive && first === null; i++) { stepGame(g, DT, bot(g, DT)); if (g.player.anchor) first = g.player.pos.y; }
  assert.ok(first !== null && first > 20 && first < s.max.y - 100, `first web at ${first?.toFixed(0)} m (roof ${s.max.y.toFixed(0)} m)`);
});

test('dive camera: falling fast with no rope (vy < -15) it rises behind him and pitches down; on a rope it does not', () => {
  const p = createPlayer();
  p.pos = { x: 0, y: 150, z: 0 }; p.vel = { x: 0, y: -20, z: 8 };
  let c = null;
  for (let i = 0; i < 120; i++) c = followCamera(p, c, DT);
  const look = () => pitchOf(c, { x: c.lx, y: c.ly, z: c.lz });
  assert.ok(look() < -30, `pitch ${look().toFixed(0)}`);
  assert.ok(c.y > p.pos.y + CFG.render.camUp, 'above the normal follow height');
  p.anchor = { x: 14, y: 200, z: 40 };
  for (let i = 0; i < 240; i++) c = followCamera(p, c, DT);
  assert.ok(look() > -10, 'the swing camera again');
});

test('vertical wall run: thrown up at a facade he climbs >= 10 m, then vaults and perches on the roof edge or kicks off', () => {
  for (const top of [70, 200]) {
    const g = createGame(1);
    g.world.structures = [{ id: 'G:base', kind: 'tower', attach: true, min: { x: W, y: 0, z: -50 }, max: { x: W + 30, y: top, z: 400 } }];
    g.world.fixed = true;
    stepGame(g, DT, []);
    placeHero(g.phys, g.player, { x: W - 2, y: 50, z: 0 }, { x: 6, y: 12, z: 2 });
    const ev = [], poses = new Set();
    let y0 = null, high = 0, perch = null;
    for (let i = 0; i < 60 * 5 && g.player.alive; i++) {
      ev.push(...stepGame(g, DT, []));
      poses.add(g.pose);
      if (g.player.climb && y0 === null) y0 = g.player.pos.y;
      high = Math.max(high, g.player.pos.y);
      if (g.player.perch && !perch) perch = { ...g.player.pos };
    }
    assert.ok(ev.includes('wallclimb') && poses.has('climb'), `top ${top}: ${ev.join(' ')}`);
    assert.ok(high - y0 >= 10, `top ${top}: climbed ${(high - y0).toFixed(1)} m`);
    if (top === 70) {
      assert.ok(ev.includes('vault') && perch, 'vaulted and perched');
      assert.ok(Math.abs(perch.y - (top + CFG.heroRadius)) < .1 && perch.x - W >= -.01 && perch.x - W < .5, `perched at ${JSON.stringify(perch)}`);
    } else assert.ok(ev.includes('walljump') && !ev.includes('vault'), 'too tall: kicked off');
  }
});

test('roof: he runs; after roofIdleSec with no input he slows and stands; a web press runs on', () => {
  const g = createGame(1);
  g.world.structures = [{ id: 'RF:base', kind: 'tower', attach: true, min: { x: -10, y: 0, z: -5 }, max: { x: 10, y: 30, z: 400 } }];
  g.world.fixed = true;
  stepGame(g, DT, []);
  placeHero(g.phys, g.player, { x: 0, y: 30 + CFG.heroRadius, z: 0 });
  for (let i = 0; i < 60; i++) stepGame(g, DT, []);
  assert.equal(g.pose, 'run');
  assert.ok(g.player.vel.z > CFG.roofRunSpeed - .1);
  for (let i = 0; i < 60 * (CFG.roofIdleSec + 1); i++) stepGame(g, DT, []);
  assert.equal(g.pose, 'stand');
  assert.ok(Math.hypot(g.player.vel.x, g.player.vel.z) < .5, 'standing still');
  stepGame(g, DT, [{ type: 'press', side: 'C', level: 'hi' }]); // (nothing to hit: a miss still runs him on)
  for (let i = 0; i < 30; i++) stepGame(g, DT, []);
  assert.equal(g.pose, 'run');
});
