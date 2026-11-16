import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import {
  makeRng, hash01, difficulty, createWorld, updateWorld, isSureAnchor, lineAt, lineIndex, buildSegment, segmentCorners,
  clampToStreets, crossKind, centreKind, neededSegments,
} from '../src/world.js';
import { makeStreet } from '../src/street.js';

const L = CFG.level;
const W = CFG.corridorHalfWidth;
const KINDS = ['tower', 'setback', 'frame', 'crane', 'bridge', 'ledge', 'slab', 'column', 'spire', 'roof', 'clock', 'sign', 'balcony', 'tank'];
const ID = /^(K-?\d+_-?\d+_[0-3]|[XZ]-?\d+_-?\d+[LR]\d+):\w+$/;

// Every box along `km` kilometres of street (axis, line) from its centre crossing: segments and their corner towers.
function course(seed, km, axis = 'z', line = 0) {
  const xk = crossKind(axis), all = new Map();
  for (let m = lineIndex(seed, xk, 0); lineAt(seed, xk, m) < km * 1000; m++) {
    for (const s of [...segmentCorners(seed, axis, line, m), ...buildSegment(seed, axis, line, m)]) all.set(s.id, s);
  }
  return [...all.values()];
}
const overlap = (a, b) => ['x', 'y', 'z'].every((k) => a.min[k] < b.max[k] - 1e-6 && b.min[k] < a.max[k] - 1e-6);

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

test('grid: col 0 is the start street, intersections every 120-200 m, lineIndex inverts lineAt', () => {
  for (const seed of [1, 2, 99]) {
    assert.equal(lineAt(seed, 'col', 0), 0);
    assert.ok(lineAt(seed, 'row', -1) < -W && lineAt(seed, 'row', 0) > 60, 'the hero starts mid-block');
    for (const kind of ['col', 'row']) for (let i = -30; i < 30; i++) {
      const d = lineAt(seed, kind, i + 1) - lineAt(seed, kind, i);
      assert.ok(d >= 120 && d <= 200, `${kind} ${i}: ${d}`);
      assert.equal(lineIndex(seed, kind, lineAt(seed, kind, i) + 0.5 * d), i);
      assert.equal(lineIndex(seed, kind, lineAt(seed, kind, i)), i);
    }
  }
  const spread = new Set(Array.from({ length: 20 }, (_, s) => Math.round(lineAt(s + 1, 'row', 0))));
  assert.ok(spread.size > 10, 'neighbouring seeds get different grids');
});

test('structures follow the renderer contract; ids are unique and share a prefix per composite', () => {
  for (const [axis, line] of [['z', 0], ['x', 2], ['z', -3]]) {
    const ids = new Set();
    for (const s of course(3, 6, axis, line)) {
      assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
      ids.add(s.id);
      assert.match(s.id, ID);
      assert.ok(KINDS.includes(s.kind), s.kind);
      assert.equal(typeof s.attach, 'boolean');
      for (const k of ['x', 'y', 'z']) assert.ok(s.max[k] > s.min[k], `${s.id} empty on ${k}`);
      assert.ok(s.min.y >= 0, `${s.id} below the street`);
      assert.equal(s.attach, s.kind !== 'frame' && s.kind !== 'column', `${s.id}: only frame beams and terrace columns refuse webs`);
      if (s.face) assert.match(s.face, /^[+-][xz]$/);
    }
  }
});

test('deterministic: the same seed builds the same city, whatever route reaches it', () => {
  assert.deepEqual(course(5, 2), course(5, 2));
  assert.notDeepEqual(course(5, 2), course(6, 2));
  // reach the x-street at row 1 along col 0, and along col 1 from the other side: shared boxes are identical
  const seed = 8, r1 = lineAt(seed, 'row', 1);
  const a = createWorld(seed), b = createWorld(seed);
  updateWorld(a, { x: 0, y: 40, z: r1 - 60 }, makeStreet('z', 0, 1, 0));
  const c1 = lineAt(seed, 'col', 1);
  updateWorld(b, { x: c1 + 40, y: 40, z: r1 }, makeStreet('x', 1, -1, r1));
  const byId = new Map(b.structures.map((s) => [s.id, s]));
  let shared = 0;
  for (const s of a.structures) if (byId.has(s.id)) { shared++; assert.deepEqual(s, byId.get(s.id)); }
  assert.ok(shared > 5, `only ${shared} shared boxes`);
});

test('lazy: only the current street and the cross streets at the next intersections exist, far boxes are dropped', () => {
  const seed = 4, w = createWorld(seed), st = makeStreet('z', 0, 1, 0);
  for (const z of [0, 500, 3000]) {
    const pos = { x: 0, y: 40, z };
    updateWorld(w, pos, st);
    assert.ok(w.structures.length < 600, `${w.structures.length} boxes`);
    // everything is on the current street's stretch or on a cross street within reach of it
    for (const s of w.structures) {
      assert.ok(s.max.z > z - CFG.behindDistance - 250 && s.min.z < z + CFG.viewDistance + 250, `${s.id} far along`);
    }
    // the next two intersections ahead have their corner towers and both cross-street segments
    const k = lineIndex(seed, 'row', z) + 1;
    for (const r of [k, k + 1]) {
      if (lineAt(seed, 'row', r) - z > CFG.viewDistance) continue;
      for (const q of [0, 1, 2, 3]) assert.ok(w.structures.some((s) => s.id === `K0_${r}_${q}:base`), `corner ${r} ${q}`);
      for (const m of [-1, 0]) assert.ok(w.key.includes(`x,${r},${m}`), `cross segment row ${r} col ${m}`);
    }
    // nothing of the street behind the hero beyond behindDistance + a block
    assert.ok(!w.structures.some((s) => s.max.z < z - CFG.behindDistance - 250));
  }
  // turning onto a cross street swaps the set; the corner towers of the turn stay
  const r = lineAt(seed, 'row', 1);
  updateWorld(w, { x: 5, y: 40, z: r }, makeStreet('x', 1, 1, r));
  assert.ok(w.structures.some((s) => s.id.startsWith('X1_0')), 'the new street ahead');
  assert.ok(w.structures.some((s) => s.id === 'K0_1_1:base'), 'the corner just turned round');
  assert.ok(neededSegments(seed, { x: 5, y: 40, z: r }, makeStreet('x', 1, 1, r)).length >= 3);
});

test('solid: nothing but ledges, jibs, bridges and facade fixtures (balconies, signs, clocks) reaches into a street; no two solid buildings overlap', () => {
  for (const [axis, line] of [['z', 0], ['x', 1], ['z', 2]]) {
    const c = lineAt(2, centreKind(axis), line), lat = axis === 'z' ? 'x' : 'z';
    const list = course(2, 6, axis, line);
    for (const s of list) {
      const a = s.min[lat] - c, b = s.max[lat] - c, inner = Math.min(Math.abs(a), Math.abs(b)), crosses = a < 0 && b > 0;
      if (crosses || inner < W - 1e-9) {
        assert.ok(['bridge', 'ledge', 'balcony', 'sign', 'clock'].includes(s.kind) || s.id.endsWith(':jib'), `${s.id} ${s.kind} intrudes`);
        if (['balcony', 'sign', 'clock'].includes(s.kind)) assert.ok(inner >= W - 1.5 && !crosses, `${s.id} sticks out ${W - inner} m`);
      }
    }
  }
  // the two streets meeting at a corner never put buildings into the same space
  const seed = 6, all = [];
  for (const line of [-1, 0, 1]) for (const m of [-1, 0, 1]) {
    all.push(...segmentCorners(seed, 'z', line, m), ...buildSegment(seed, 'z', line, m));
    all.push(...segmentCorners(seed, 'x', m, line), ...buildSegment(seed, 'x', m, line));
  }
  const solid = [...new Map(all.map((s) => [s.id, s])).values()].filter((s) => s.kind === 'tower');
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    assert.ok(!overlap(solid[i], solid[j]), `${solid[i].id} overlaps ${solid[j].id}`);
  }
});

test('skybridges end inside a tower on both sides', () => {
  let n = 0;
  for (const seed of [1, 2, 3]) for (const [axis, line] of [['z', 0], ['x', 1]]) {
    const list = course(seed, 10, axis, line), lat = axis === 'z' ? 'x' : 'z', c = lineAt(seed, centreKind(axis), line);
    for (const b of list.filter((s) => s.kind === 'bridge')) {
      n++;
      for (const sd of [-1, 1]) {
        const v = c + sd * (W + 1);
        assert.ok(list.some((t) => t.kind === 'tower' && t.min[lat] <= v && t.max[lat] >= v
          && t.min[axis] <= b.min[axis] && t.max[axis] >= b.max[axis] && t.max.y >= b.max.y), `${b.id} hangs free`);
      }
    }
  }
  assert.ok(n > 5, `only ${n} bridges`);
});

// The "no impossible section" invariant along every street: the union of sure anchors (solid towers on the street's
// face, at least goodH tall, block-corner towers included) leaves no hole longer than maxGap anywhere; an
// intersection is a 2 * corridorHalfWidth hole between corner towers.
test('no impossible section: along streets on 5 seeds, sure-anchor holes never exceed maxGap', () => {
  for (const seed of [1, 2, 3, 4, 5]) for (const [axis, line, km] of [['z', 0, 20], ['x', 3, 6], ['z', -2, 6]]) {
    const lat = axis === 'z' ? 'x' : 'z', c = lineAt(seed, centreKind(axis), line);
    const sure = course(seed, km, axis, line).filter((s) => isSureAnchor(s, lat, c)).sort((a, b) => a.min[axis] - b.min[axis]);
    let end = sure[0].max[axis], worst = 0;
    for (const s of sure) {
      const hole = s.min[axis] - end;
      if (hole > 0) {
        worst = Math.max(worst, hole);
        assert.ok(hole <= difficulty(Math.abs(c) + Math.abs(s.min[axis])).maxGap + 1e-9, `seed ${seed} ${axis}${line}: ${hole.toFixed(1)} m hole at ${end.toFixed(0)}`);
      }
      end = Math.max(end, s.max[axis]);
    }
    assert.ok(end >= km * 1000 - 400, `seed ${seed}: coverage stops at ${end}`);
    if (km === 20) assert.ok(worst > L.maxGapStart, `seed ${seed}: the late course never opens up (worst hole ${worst})`);
  }
});

test('variety: the late course has one-sided stretches, low towers, terraces, cranes, bridges, gaps; no hollow frames', () => {
  const late = course(4, 20).filter((s) => s.min.z > L.easyZ + L.rampZ);
  const has = (f) => late.some(f);
  assert.ok(has((s) => s.kind === 'tower' && s.max.y < L.goodH), 'low towers');
  assert.ok(has((s) => s.kind === 'tower' && s.max.y > 120), 'high towers');
  for (const k of ['crane', 'bridge', 'setback', 'slab', 'column', 'spire', 'roof', 'clock', 'sign', 'balcony', 'tank']) assert.ok(has((s) => s.kind === k), k);
  assert.ok(!has((s) => s.kind === 'frame'), 'hollow frames are retired');
  // a face with no lot over most of a block (a gap or a one-sided stretch)
  const towers = (sd) => late.filter((s) => s.kind === 'tower' && !s.id.startsWith('K') && Math.sign(s.min.x + s.max.x) === sd);
  const longestEmpty = (list) => {
    list.sort((a, b) => a.min.z - b.min.z);
    let end = list[0].max.z, best = 0;
    for (const s of list) { best = Math.max(best, s.min.z - end); end = Math.max(end, s.max.z); }
    return best;
  };
  assert.ok(Math.max(longestEmpty(towers(-1)), longestEmpty(towers(1))) > 60);
});

test('easier early: the first 400 m is dense towers on both sides, no frames, terraces, cranes, bridges or gaps', () => {
  for (const seed of [7, 8]) {
    const early = course(seed, 1).filter((s) => s.max.z < L.easyZ);
    assert.ok(early.every((s) => !['frame', 'crane', 'bridge', 'slab', 'column'].includes(s.kind)), 'only plain buildings');
    for (const sd of [-1, 1]) {
      const t = early.filter((s) => s.kind === 'tower' && Math.sign(s.min.x) === sd).sort((a, b) => a.min.z - b.min.z);
      for (let i = 1; i < t.length; i++) {
        const gap = t[i].min.z - t[i - 1].max.z;
        assert.ok(gap < 1 || Math.abs(gap - 2 * W) < 1e-6, `seed ${seed}: a ${gap.toFixed(1)} m seam that is not an intersection`);
      }
    }
  }
});

test('clampToStreets: blocks are out of bounds, streets and intersections are not', () => {
  const seed = 3, c1 = lineAt(seed, 'col', 1), r1 = lineAt(seed, 'row', 1), m = CFG.streetMargin;
  for (const p of [{ x: 0, y: 30, z: 50 }, { x: W + m - 0.01, y: 90, z: 50 }, { x: 60, y: 30, z: r1 + 3 }, { x: c1 - 5, y: 3, z: r1 + 10 }]) {
    const q = { ...p }, v = { x: 1, y: 0, z: 1 };
    assert.equal(clampToStreets(seed, q, v), false, JSON.stringify(p));
    assert.deepEqual(q, p);
  }
  const q = { x: W + m + 2, y: 30, z: 50 }, v = { x: 5, y: 1, z: 9 };
  assert.equal(clampToStreets(seed, q, v), true);
  assert.deepEqual([q.x, v.x, v.z], [W + m, 0, 9]); // back onto the street's edge, no more velocity into the block
});

// W (side 'C') fires straight ahead at aimUpDeg: cranes must hang their jib across the street, low enough for
// that web from flight height, and often enough late in the course that W matters.
test('cranes: jibs span most of the street within W reach, at least every ~400 m late', () => {
  for (const seed of [1, 2, 3]) {
    const late = course(seed, 12).filter((s) => s.min.z > L.easyZ + L.rampZ);
    const jibs = late.filter((s) => s.id.endsWith(':jib'));
    const zs = late.map((s) => s.min.z);
    const span = Math.max(...zs) - Math.min(...zs);
    // (on the grid about half of every block is corner towers, so lots - and cranes - are rarer per metre)
    assert.ok(jibs.length >= span / 400, `seed ${seed}: ${jibs.length} jibs in ${span.toFixed(0)} m`);
    for (const j of jibs) {
      assert.ok(j.min.x < -5 && j.max.x > 5, `${j.id} does not reach across the centreline`);
      const rise = j.min.y - 60, run = rise / Math.tan(CFG.aimUpDeg.mid * Math.PI / 180); // from a 60 m flight height
      assert.ok(Math.hypot(rise, run) < CFG.webRange, `${j.id} out of W reach from 60 m`);
    }
  }
});
