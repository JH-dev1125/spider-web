import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { makeRng, difficulty, createWorld, updateWorld } from '../src/world.js';

test('difficulty curve', () => {
  assert.equal(difficulty(0).speed, CFG.baseSpeed);
  assert.equal(difficulty(CFG.easySeconds).speed, CFG.baseSpeed);
  assert.ok(difficulty(300).speed > difficulty(60).speed);
  assert.ok(difficulty(300).speed <= CFG.maxSpeed);
  let prev = difficulty(0);
  for (let t = 1; t <= 400; t++) {
    const d = difficulty(t);
    assert.ok(d.gapMax >= prev.gapMax);
    prev = d;
  }
});

const build = (seed, t = 0, z = 0) => {
  const rng = makeRng(seed);
  const w = createWorld(rng);
  updateWorld(w, z, t, rng);
  return w;
};

test('deterministic by seed', () => {
  assert.deepEqual(build(7).buildings, build(7).buildings);
});

test('no overlap, gaps in range, tall building exists', () => {
  const t = 100, d = difficulty(t);
  const w = build(3, t);
  for (const side of ['L', 'R']) {
    const bs = w.buildings.filter((b) => b.side === side).sort((a, b) => a.z0 - b.z0);
    assert.ok(bs.length > 1);
    for (let i = 1; i < bs.length; i++) {
      const gap = bs[i].z0 - bs[i - 1].z1;
      assert.ok(gap >= d.gapMin - 1e-9 && gap <= d.gapMax + 1e-9, `gap ${gap}`);
    }
  }
  assert.ok(w.buildings.some((b) => b.h > CFG.startHeight));
});

test('culls behind, bounded length', () => {
  const rng = makeRng(5);
  const w = createWorld(rng);
  for (let z = 0; z <= 1000; z += 10) updateWorld(w, z, 0, rng);
  assert.ok(w.buildings.every((b) => b.z1 >= 1000 - CFG.behindDistance));
  assert.ok(w.buildings.length < 200);
});

test('start area covered on both sides', () => {
  const w = build(11);
  for (const side of ['L', 'R'])
    assert.ok(w.buildings.some((b) => b.side === side && b.z0 <= 40 && b.z1 >= 0));
});

test('hash01 matches makeRng first draw, handles negatives, stays in [0,1)', async () => {
  const { hash01 } = await import('../src/world.js');
  for (const n of [0, 1, 2, 99, -1, -7, -123456, 2 ** 31, -(2 ** 31)]) {
    assert.equal(hash01(n), makeRng(n)());
    const v = hash01(n);
    assert.ok(v >= 0 && v < 1);
  }
  assert.notEqual(hash01(-1), hash01(1));
});
