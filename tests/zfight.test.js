// Z-fighting: no two structure boxes put overlapping faces in one plane facing the same way, and every overlay plane
// (cornices, plates, splats, dials, signs) stands at least 1 cm off the face it covers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { buildSegment, segmentCorners, lineIndex, lineAt, createWorld } from '../src/world.js';

const AX = ['x', 'y', 'z'];
// pairs of boxes with a face in the same plane, facing the same way, overlapping with area (ground bottoms excepted)
function coplanar(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    for (const k of AX) for (const side of ['min', 'max']) {
      if (Math.abs(a[side][k] - b[side][k]) > 1e-6 || (k === 'y' && side === 'min' && a.min.y === 0)) continue;
      const [u, v] = AX.filter((q) => q !== k);
      const ou = Math.min(a.max[u], b.max[u]) - Math.max(a.min[u], b.min[u]), ov = Math.min(a.max[v], b.max[v]) - Math.max(a.min[v], b.min[v]);
      if (ou > 1e-6 && ov > 1e-6) out.push(`${a.id} / ${b.id} (${side} ${k})`);
    }
  }
  return out;
}

test('no two structure boxes share an overlapping coplanar face (z-streets and x-streets, the start tower included)', () => {
  for (const seed of [1, 2, 3, 4]) for (const axis of ['z', 'x']) {
    const xk = axis === 'z' ? 'row' : 'col', all = new Map();
    for (let m = lineIndex(seed, xk, 0) - 1; lineAt(seed, xk, m) < 2500; m++) {
      for (const s of [...segmentCorners(seed, axis, 0, m), ...buildSegment(seed, axis, 0, m)]) all.set(s.id, s);
    }
    if (axis === 'z') { const s = createWorld(seed).start; all.set(s.id, s); }
    const bad = coplanar([...all.values()]);
    assert.deepEqual(bad, [], `seed ${seed} ${axis}-street: ${bad.slice(0, 5).join('; ')}`);
  }
});

test('overlay planes stand at least 1 cm off their host faces (and close enough to read as on them)', () => {
  const R = CFG.render;
  for (const k of ['trimProud', 'decalLift']) assert.ok(R[k] >= 0.01 && R[k] <= 0.06, `${k} ${R[k]}`);
  assert.ok(R.near >= 0.3, 'near plane at least 0.3 m (depth precision)');
});
