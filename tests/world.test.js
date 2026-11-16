import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { makeRng, hash01, difficulty, createWorld, updateWorld, isSureAnchor } from '../src/world.js';

const L = CFG.level;
const W = CFG.corridorHalfWidth;
const KINDS = ['tower', 'setback', 'crane', 'bridge', 'slab', 'column', 'spire', 'roof', 'clock', 'sign', 'balcony', 'tank'];

// Every box a course of `km` kilometres ever produces (the world culls behind, so collect as the hero advances).
function course(seed, km) {
  const w = createWorld(seed), all = new Map();
  for (let z = 0; z <= km * 1000; z += 20) {
    updateWorld(w, z);
    for (const s of w.structures) all.set(s.id, s);
  }
  return [...all.values()];
}

test('makeRng / hash01: deterministic, hash01(n) is makeRng(n)() and stays in [0,1)', () => {
  for (const n of [0, 1, 7, 123456, -1, -99]) {
    assert.equal(hash01(n), makeRng(n)());
    assert.ok(hash01(n) >= 0 && hash01(n) < 1);
  }
  assert.notEqual(hash01(-1), hash01(1));
});

test('difficulty ramps with distance: wider gaps, more one-sided stretches, fewer plain towers', () => {
  const a = difficulty(0), b = difficulty(L.easyZ + L.rampZ), c = difficulty(1e9);
  assert.equal(a.p, 0);
  assert.equal(b.p, 1);
  assert.deepEqual(b, c);
  assert.ok(a.maxGap < b.maxGap && a.oneSide < b.oneSide && a.weights.tower > b.weights.tower);
  assert.ok(b.maxGap <= L.maxGapEnd);
});

test('structures follow the renderer contract; ids are unique and share a prefix per composite', () => {
  const list = course(3, 6);
  const ids = new Set();
  for (const s of list) {
    assert.equal(typeof s.id, 'string');
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.match(s.id, /^[LR]\d+:\w+$/);
    assert.ok(KINDS.includes(s.kind), s.kind);
    assert.equal(typeof s.attach, 'boolean');
    for (const k of ['x', 'y', 'z']) assert.ok(s.max[k] > s.min[k], `${s.id} empty on ${k}`);
    assert.ok(s.min.y >= 0, `${s.id} below the street`);
    assert.equal(s.attach, s.kind !== 'column', `${s.id}: only terrace columns refuse webs`);
  }
});

test('deterministic by seed', () => {
  assert.deepEqual(course(5, 2), course(5, 2));
  assert.notDeepEqual(course(5, 2), course(6, 2));
});

test('adds ahead to viewDistance, removes behind behindDistance', () => {
  const w = createWorld(1);
  for (const z of [0, 500, 3000]) {
    updateWorld(w, z);
    assert.ok(w.structures.every((s) => s.max.z >= z - CFG.behindDistance));
    assert.ok(Math.min(w.nextZ.L, w.nextZ.R) >= z + CFG.viewDistance);
    assert.ok(w.structures.length < 400);
  }
});

test('solid: nothing but jibs, bridges and facade fixtures (balconies, signs, clocks) reaches into the corridor', () => {
  for (const s of course(2, 10)) {
    const inner = Math.min(Math.abs(s.min.x), Math.abs(s.max.x)), crosses = s.min.x < 0 && s.max.x > 0;
    if (crosses || inner < W - 1e-9) {
      assert.ok(['bridge', 'balcony', 'sign', 'clock'].includes(s.kind) || s.id.endsWith(':jib'), `${s.id} ${s.kind} intrudes`);
      if (s.kind !== 'bridge' && !s.id.endsWith(':jib')) assert.ok(inner >= W - 1.5 && !crosses, `${s.id} sticks out ${W - inner} m`);
    }
  }
});

test('skybridges end inside a tower on both sides', () => {
  let n = 0;
  for (const seed of [1, 2, 3]) {
    const list = course(seed, 10);
    for (const b of list.filter((s) => s.kind === 'bridge')) {
      n++;
      for (const sd of [-1, 1]) {
        const x = sd * (W + 1);
        assert.ok(list.some((t) => t.kind === 'tower' && t.min.x <= x && t.max.x >= x
          && t.min.z <= b.min.z && t.max.z >= b.max.z && t.max.y >= b.max.y), `${b.id} hangs free`);
      }
    }
  }
  assert.ok(n > 5, `only ${n} bridges`);
});

// The "no impossible section" invariant: the union of sure anchors (solid towers on the corridor face, at least
// goodH tall, so a mid web from flight height lands on them) leaves no hole longer than maxGap anywhere
// (maxGap only grows with z, so the allowance at the far end of a hole bounds the one the generator used).
test('no impossible section: 20 km on 5 seeds, sure-anchor holes never exceed maxGap', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const sure = course(seed, 20).filter(isSureAnchor).sort((a, b) => a.min.z - b.min.z);
    let end = L.startZ, worst = 0;
    for (const s of sure) {
      const hole = s.min.z - end;
      if (hole > 0) {
        worst = Math.max(worst, hole);
        assert.ok(hole <= difficulty(s.min.z).maxGap + 1e-9, `seed ${seed}: ${hole.toFixed(1)} m hole at z=${end.toFixed(0)}`);
      }
      end = Math.max(end, s.max.z);
    }
    assert.ok(end >= 20000, `seed ${seed}: coverage stops at ${end}`);
    assert.ok(worst > L.maxGapStart, `seed ${seed}: the late course never opens up (worst hole ${worst})`);
  }
});

test('variety: the late course has one-sided stretches, low towers, terraces, cranes, bridges, gaps; no hollow frames', () => {
  const late = course(4, 20).filter((s) => s.min.z > L.easyZ + L.rampZ);
  const has = (f) => late.some(f);
  assert.ok(has((s) => s.kind === 'tower' && s.max.y < L.goodH), 'low towers');
  assert.ok(has((s) => s.kind === 'tower' && s.max.y > 120), 'high towers');
  for (const k of ['crane', 'bridge', 'setback', 'slab', 'column', 'spire', 'roof', 'clock', 'sign', 'balcony', 'tank']) assert.ok(has((s) => s.kind === k), k);
  assert.ok(!has((s) => s.kind === 'frame'), 'hollow frames are retired');
  // a 100 m stretch with no tower on one side (a gap or a one-sided section)
  const towers = (sd) => late.filter((s) => s.kind === 'tower' && Math.sign(s.min.x + s.max.x) === sd);
  const longestEmpty = (list) => {
    list.sort((a, b) => a.min.z - b.min.z);
    let end = list[0].max.z, best = 0;
    for (const s of list) { best = Math.max(best, s.min.z - end); end = Math.max(end, s.max.z); }
    return best;
  };
  assert.ok(Math.max(longestEmpty(towers(-1)), longestEmpty(towers(1))) > 100);
});

test('easier early: the first 400 m is dense towers on both sides, no terraces, cranes, bridges or gaps', () => {
  const early = course(7, 1).filter((s) => s.max.z < L.easyZ);
  assert.ok(early.every((s) => !['crane', 'bridge', 'slab', 'column'].includes(s.kind)), 'only plain buildings');
  for (const sd of [-1, 1]) {
    const t = early.filter((s) => s.kind === 'tower' && Math.sign(s.min.x) === sd).sort((a, b) => a.min.z - b.min.z);
    for (let i = 1; i < t.length; i++) assert.ok(t[i].min.z - t[i - 1].max.z < 1, 'seams narrower than the hero');
  }
});

// W (side 'C') fires straight ahead at aimUpDeg: cranes must hang their jib across the street, low enough for
// that web from flight height, and often enough late in the course that W matters.
test('cranes: jibs span most of the street within W reach, at least every ~300 m late', () => {
  for (const seed of [1, 2, 3]) {
    const late = course(seed, 12).filter((s) => s.min.z > L.easyZ + L.rampZ);
    const jibs = late.filter((s) => s.id.endsWith(':jib'));
    const zs = late.map((s) => s.min.z);
    const span = Math.max(...zs) - Math.min(...zs);
    assert.ok(jibs.length >= span / 300, `seed ${seed}: ${jibs.length} jibs in ${span.toFixed(0)} m`);
    for (const j of jibs) {
      assert.ok(j.min.x < -5 && j.max.x > 5, `${j.id} does not reach across the centreline`);
      const rise = j.min.y - 30, run = rise / Math.tan(CFG.aimUpDeg.mid * Math.PI / 180);
      assert.ok(Math.hypot(rise, run) < CFG.webRange, `${j.id} out of W reach from 30 m`);
    }
  }
});
