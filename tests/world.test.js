import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { makeRng, hash01, difficulty, createWorld, updateWorld, isSureAnchor } from '../src/world.js';

const L = CFG.level;
const W = CFG.corridorHalfWidth;
const KINDS = ['tower', 'setback', 'frame', 'crane', 'bridge', 'ledge'];

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
    assert.equal(s.attach, s.kind !== 'frame', `${s.id}: only frame beams refuse webs`);
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

test('solid: towers are single boxes, nothing but ledges/jibs/bridges reaches into the corridor', () => {
  for (const s of course(2, 10)) {
    const inner = Math.min(Math.abs(s.min.x), Math.abs(s.max.x)), crosses = s.min.x < 0 && s.max.x > 0;
    if (crosses || inner < W - 1e-9) {
      assert.ok(s.kind === 'bridge' || s.kind === 'ledge' || s.id.endsWith(':jib'), `${s.id} ${s.kind} intrudes`);
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

test('variety: the late course has one-sided stretches, low towers, frames, cranes, bridges, gaps', () => {
  const late = course(4, 20).filter((s) => s.min.z > L.easyZ + L.rampZ);
  const has = (f) => late.some(f);
  assert.ok(has((s) => s.kind === 'tower' && s.max.y < L.goodH), 'low towers');
  assert.ok(has((s) => s.kind === 'tower' && s.max.y > 120), 'high towers');
  for (const k of ['frame', 'crane', 'bridge', 'setback', 'ledge']) assert.ok(has((s) => s.kind === k), k);
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

test('easier early: the first 400 m is dense towers on both sides, no frames, cranes, bridges or gaps', () => {
  const early = course(7, 1).filter((s) => s.max.z < L.easyZ);
  assert.ok(early.every((s) => ['tower', 'setback', 'ledge'].includes(s.kind)));
  for (const sd of [-1, 1]) {
    const t = early.filter((s) => s.kind === 'tower' && Math.sign(s.min.x) === sd).sort((a, b) => a.min.z - b.min.z);
    for (let i = 1; i < t.length; i++) assert.ok(t[i].min.z - t[i - 1].max.z < 1, 'seams narrower than the hero');
  }
});
