import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { makeRng } from '../src/world.js';
import { buildBuilding, streetLot, ARCHETYPES, TALL_MIN, BAND } from '../src/archetypes.js';
import { createPlayer, createPhysics, syncStructures, raycast } from '../src/player.js';

const W = CFG.corridorHalfWidth;
const EPS = 1e-9;
const overlap = (a, b) => ['x', 'y', 'z'].every((k) => a.min[k] < b.max[k] - EPS && b.min[k] < a.max[k] - EPS);

// Many buildings over seeds, heights, both street sides and the full difficulty range.
function* buildings(n = 600) {
  for (let i = 0; i < n; i++) {
    const rng = makeRng(1000 + i), sd = i % 2 ? 1 : -1;
    const depth = 18 + 16 * rng(), z0 = 100 * i, len = 24 + 46 * rng();
    const h = i % 3 ? 42 + 108 * rng() : 12 + 18 * rng();
    const fp = streetLot(`${sd > 0 ? 'R' : 'L'}${i}`, sd, W, depth, z0, z0 + len);
    yield { fp, h, sd, list: buildBuilding(fp, h, rng, { p: (i % 5) / 4 }) };
  }
}

test('archetypes: solid, non-empty, non-overlapping boxes inside the footprint (fixtures may stand 1.5 m proud)', () => {
  for (const { fp, h, list } of buildings()) {
    const ids = new Set();
    for (const s of list) {
      assert.ok(!ids.has(s.id), s.id); ids.add(s.id);
      assert.match(s.id, /^[LR]\d+:\w+$/);
      for (const k of ['x', 'y', 'z']) assert.ok(s.max[k] > s.min[k], `${s.id} empty on ${k}`);
      assert.ok(s.min.y >= 0);
      assert.equal(s.attach, s.kind !== 'column', s.id);
      const proud = ['balcony', 'sign', 'clock'].includes(s.kind) ? 1.5 : 0;
      assert.ok(s.min.x >= fp.x0 - proud - EPS && s.max.x <= fp.x1 + proud + EPS && s.min.z >= fp.z0 - EPS && s.max.z <= fp.z1 + EPS, `${s.id} outside its lot`);
    }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      assert.ok(!overlap(list[i], list[j]), `${list[i].id} overlaps ${list[j].id}`);
    }
    const face = list.filter((s) => s.kind === 'tower');
    assert.equal(Math.max(...face.map((s) => s.max.y)), h, 'the face block keeps the lot height');
  }
});

test('every archetype appears over many seeds; tall lots get towers, low lots low-rises', () => {
  const seen = new Map();
  for (const { h, list } of buildings()) {
    const a = list[0].arch;
    seen.set(a, (seen.get(a) ?? 0) + 1);
    assert.equal(['brownstone', 'walkup', 'warehouse'].includes(a), h < TALL_MIN, `${a} at ${h.toFixed(0)} m`);
  }
  assert.ok(ARCHETYPES.length >= 10);
  for (const a of ARCHETYPES) assert.ok(seen.get(a) >= 5, `${a}: ${seen.get(a) ?? 0}`);
});

test('terrace bands: open floors with only columns, solid face above, nothing attachable hung in front', () => {
  let bands = 0;
  for (const { list, h } of buildings()) {
    const floors = list.filter((s) => s.id.endsWith('floor')).sort((a, b) => a.min.y - b.min.y);
    let prevTop = -Infinity;
    for (const f of floors) {
      bands++;
      const o0 = f.max.y, o1 = o0 + BAND.open;
      assert.ok(o0 >= BAND.minStart - EPS, 'band too low');
      assert.ok(o0 - prevTop >= BAND.minSolid - EPS, 'bands too close');
      prevTop = o1;
      assert.ok(h - o1 >= BAND.minSolid - EPS, `only ${(h - o1).toFixed(1)} m of solid face above the band`);
      const inBand = list.filter((s) => s.min.y < o1 - EPS && s.max.y > o0 + EPS);
      assert.ok(inBand.length >= 6);
      for (const s of inBand) assert.ok(s.kind === 'column' && !s.attach, `${s.id} (${s.kind}) inside the open band`);
    }
  }
  assert.ok(bands > 50, `only ${bands} bands`);
});

test('a web into a terrace band between columns flies through and misses; the slabs above and below hold', () => {
  for (const { list, sd } of buildings(300)) {
    const floor = list.find((s) => s.id.endsWith('t0floor'));
    if (!floor) continue;
    const cols = list.filter((s) => /:t0c\d+$/.test(s.id) && Math.abs((sd > 0 ? s.min.x : s.max.x) - sd * W) < EPS)
      .sort((a, b) => a.min.z - b.min.z);
    const ph = createPhysics(createPlayer());
    syncStructures(ph, list);
    const zGap = (cols[0].max.z + cols[1].min.z) / 2, y = floor.max.y + BAND.open / 2;
    const from = { x: 0, y, z: zGap }, dir = { x: sd, y: 0, z: 0 };
    assert.equal(raycast(ph, from, dir, 200), null, 'a web through the band hits nothing');
    for (const yy of [floor.min.y + 0.4, floor.max.y + BAND.open + 0.4]) {
      const r = raycast(ph, { x: 0, y: yy, z: zGap }, dir, 200);
      assert.ok(r?.attach && Math.abs(r.point.x - sd * W) < 1e-6, `slab at ${yy} holds`);
    }
    return;
  }
  assert.fail('no terrace band found');
});

test('the streetSide frame also works for streets along x (corner turns)', () => {
  const rng = makeRng(5);
  for (const streetSide of ['+z', '-z']) {
    const list = buildBuilding({ id: 'R1', x0: 0, x1: 40, z0: 100, z1: 125, streetSide }, 80, rng, { p: 1 });
    for (const s of list) {
      const proud = ['balcony', 'sign', 'clock'].includes(s.kind) ? 1.5 : 0;
      assert.ok(s.min.x >= -EPS && s.max.x <= 40 + EPS && s.min.z >= 100 - proud - EPS && s.max.z <= 125 + proud + EPS, s.id);
    }
  }
});
