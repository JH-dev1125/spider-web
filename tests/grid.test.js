// The city grid in play: corner turns, the street frame, the street bounds, the score along streets, the camera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createGame, stepGame, createBot, aim } from '../src/game.js';
import { lineAt, lineIndex, corridorAt, updateWorld } from '../src/world.js';
import { syncStructures, placeHero } from '../src/player.js';
import { heading, right, makeStreet } from '../src/street.js';
import { followCamera } from '../src/render-math.js';
import { createPlayer } from '../src/player.js';

const DT = 1 / 60, W = CFG.corridorHalfWidth;
const unit = (v) => { const n = Math.hypot(v.x, v.z); return { x: v.x / n, z: v.z / n }; };
const dot2 = (a, b) => a.x * b.x + a.z * b.z;

// Put the hero on the start street `before` metres short of row `row`, at height y, flying forward at speed.
function approach(seed, { row = 1, before = 72, y = 45, speed = 20 } = {}) {
  const g = createGame(seed), z = lineAt(seed, 'row', row) - before;
  placeHero(g.phys, g.player, { x: 0, y, z }, { x: 0, y: 0, z: speed });
  updateWorld(g.world, g.player.pos, g.street);
  syncStructures(g.phys, g.world.structures);
  return g;
}

test('a corner turn: the bot webs the near corner tower, the street switches, aims rotate with it, he flies on', () => {
  let ok = 0;
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const seed of seeds) for (const side of ['R', 'L']) {
    const g = approach(seed);
    let bot = createBot({ turn: side }), turnedAt = -1, corner = null, street = null;
    for (let i = 0; i < 60 * 14 && g.player.alive; i++) {
      const ev = stepGame(g, DT, bot(g, DT));
      if (g.player.anchor && turnedAt < 0) corner = g.player.anchor; // the rope he turned on (the last before the switch)
      if (turnedAt < 0 && ev.includes('turned')) {
        turnedAt = i;
        street = g.street;
        // turning right from +z heads +x, left heads -x; the new street is the x-street through that intersection
        assert.equal(street.axis, 'x');
        assert.equal(street.dir, side === 'R' ? 1 : -1, `seed ${seed} ${side}`);
        assert.equal(street.centre, lineAt(seed, 'row', 1));
        // aims rotated: 'right' is now right of the new heading, 'ahead' along it
        const h = heading(street), r = right(street);
        for (const level of ['hi', 'mid', 'lo']) for (const s of ['L', 'R']) {
          const a = aim(g, s, level), d = unit({ x: a.to.x - a.from.x, z: a.to.z - a.from.z });
          assert.ok(dot2(d, h) > 0.8, `seed ${seed}: ${s} ${level} not ahead`); // (aimAhead 40: a far-side web from beside a face yaws ~32 deg)
          assert.ok(dot2(d, r) * (s === 'R' ? 1 : -1) > 0, `seed ${seed}: ${s} ${level} on the wrong side`);
        }
        // the corner it webbed is the near corner tower on that side, short of the intersection
        assert.ok(corner && corner.z < street.centre - W + 1e-6 && Math.sign(corner.x) === street.dir, `seed ${seed}: anchored at ${JSON.stringify(corner)}`);
      }
      if (turnedAt >= 0 && i === turnedAt + 20) bot = createBot(); // then plain flying down the new street
      if (turnedAt >= 0 && i - turnedAt > 60 * 8) break;
    }
    if (turnedAt < 0 || !g.player.alive) continue;
    ok++;
    // he really travelled the new street: well along it from the corner
    assert.ok(g.player.pos.x * street.dir > 60, `seed ${seed}: only ${g.player.pos.x.toFixed(0)} m along`);
  }
  assert.ok(ok >= 12, `turned and survived 8 s in only ${ok} of ${seeds.length * 2}`);
});

test('no diagonal escape: over long runs the hero stays on the streets (within streetMargin of a corridor)', () => {
  const m = CFG.streetMargin + 1e-6;
  for (let seed = 1; seed <= 8; seed++) for (const turn of [null, 'R']) {
    const g = createGame(seed), bot = createBot({ turn });
    let far = 0;
    for (let i = 0; i < 60 * 30 && g.player.alive; i++) {
      stepGame(g, DT, bot(g, DT));
      const p = g.player.pos;
      assert.ok(corridorAt(seed, 'col', p.x, m) !== null || corridorAt(seed, 'row', p.z, m) !== null,
        `seed ${seed} frame ${i}: off the streets at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
      // and on his own street, or in the intersection square he is turning through
      const off = Math.abs(p[g.street.lat] - g.street.centre);
      const atCross = corridorAt(seed, g.street.axis === 'z' ? 'row' : 'col', p[g.street.axis], m) !== null;
      assert.ok(off <= W + m || atCross, `seed ${seed} frame ${i}: ${off.toFixed(1)} m off his street`);
      far = Math.max(far, Math.hypot(p.x, p.z));
    }
    assert.ok(far > 150, `seed ${seed}: barely moved`);
  }
});

test('score: the distance is the path along the streets (velocity along the current street), turns included', () => {
  let turned = 0;
  for (const seed of [1, 2, 3, 4]) {
    const g = approach(seed), bot = createBot({ turn: 'R' });
    let sum = 0;
    for (let i = 0; i < 60 * 12 && g.player.alive; i++) {
      const st = g.street, before = { ...g.player.pos }, d0 = g.distance;
      const ev = stepGame(g, DT, bot(g, DT));
      const h = heading(st), step = (g.player.pos.x - before.x) * h.x + (g.player.pos.z - before.z) * h.z;
      assert.ok(Math.abs(g.distance - d0 - step) < 1e-9, `seed ${seed} frame ${i}`);
      sum += step;
      if (ev.includes('turned')) turned++;
    }
    assert.ok(Math.abs(g.distance - sum) < 1e-6);
  }
  assert.ok(turned > 0);
  // on the start street it is just the distance down it
  const g = createGame(5), bot = createBot();
  for (let i = 0; i < 600 && g.player.alive; i++) stepGame(g, DT, bot(g, DT));
  if (g.street.axis === 'z') assert.ok(Math.abs(g.distance - g.player.pos.z) < 1e-6);
});

test('the start street keeps the old corridor frame: z-street along x = 0, heading +z', () => {
  const g = createGame(1);
  assert.deepEqual({ ...g.street }, makeStreet('z', 0, 1, 0));
  assert.equal(lineIndex(1, 'col', 0), 0);
  assert.equal(g.distance, 0);
});

test('camera: turns with the street, smoothly, no faster than camTurnRate, and ends up behind him along it', () => {
  const p = createPlayer();
  p.pos = { x: 0, y: 40, z: 100 }; p.vel = { x: 0, y: 0, z: 20 };
  const zSt = makeStreet('z', 0, 1, 0), xSt = makeStreet('x', 1, 1, 100);
  let c = followCamera(p, null, DT, [], zSt);
  assert.ok(Math.abs(c.yaw) < 1e-12);
  p.vel = { x: 20, y: 0, z: 0 };
  const yaws = [c.yaw];
  for (let i = 0; i < 180; i++) {
    p.pos.x += p.vel.x * DT;
    c = followCamera(p, c, DT, [], xSt);
    yaws.push(c.yaw);
    assert.ok(c.fovDeg >= CFG.render.fovMin - 1e-9 && c.fovDeg <= CFG.render.fovMax + 1e-9);
  }
  for (let i = 1; i < yaws.length; i++) {
    const step = (yaws[i] - yaws[i - 1]) * 180 / Math.PI;
    assert.ok(step >= -1e-9 && step <= CFG.camTurnRate * DT + 1e-9, `frame ${i}: ${step.toFixed(2)} deg`);
  }
  assert.ok(yaws[1] - yaws[0] > 0, 'starts turning at once');
  assert.ok(Math.abs(c.yaw - Math.PI / 2) < 0.01, `ends at ${c.yaw}`);
  // behind him along +x, above, looking ahead along +x
  assert.ok(c.x < p.pos.x - CFG.render.camBack * 0.8 && Math.abs(c.z - p.pos.z) < 2 && c.y > p.pos.y);
  assert.ok(c.lx > p.pos.x);
  // frame-rate independent: 1/30 s steps reach about the same yaw as 1/60 s steps
  const run = (dt) => {
    let k = followCamera(p, null, dt, [], zSt);
    for (let t = 0; t < 0.5 - 1e-9; t += dt) k = followCamera(p, k, dt, [], xSt);
    return k.yaw;
  };
  assert.ok(Math.abs(run(1 / 30) - run(1 / 60)) < 0.03, `${run(1 / 30)} vs ${run(1 / 60)}`);
});
