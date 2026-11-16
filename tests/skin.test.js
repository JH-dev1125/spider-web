// The skinned suit: every vertex follows its own segment and that segment's parent only, and no pose tears the skin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skinSurface, skinPoint, PARENT_OF } from '../src/character.js';
import { ANATOMY } from '../src/ragdoll.js';
import { MOVES, FLIGHT, sampleMove } from '../src/moves.js';
import { Quaternion, Vec3 } from '../vendor/cannon-es.js';

const g = skinSurface(), STEP = .022;

test('skin weights: each vertex is weighted to its own bone and, near the joint, that bone\'s direct parent', () => {
  for (let i = 0; i < g.weights.length; i += 4) {
    const used = [0, 1, 2, 3].filter((k) => g.weights[i + k] > 0).map((k) => ANATOMY[g.skinIndices[i + k]].name);
    assert.ok(used.length >= 1 && used.length <= 2);
    if (used.length === 2) assert.equal(PARENT_OF[used[0]], used[1], `vertex ${i / 4}: ${used}`);
  }
});

// Forward kinematics of world segment orientations through the ragdoll's own joint pivots (as the physics joints hold them).
const fk = (targets) => {
  const out = {};
  for (const a of ANATOMY) {
    const q = targets[a.name];
    if (!a.parent) { out[a.name] = { pos: [0, 0, 0], q: [q.x, q.y, q.z, q.w] }; continue; }
    const P = out[a.parent], pa = ANATOMY.find((x) => x.name === a.parent).at;
    const j = new Quaternion(...P.q).vmult(new Vec3(...a.joint.map((v, k) => v - pa[k])));
    const c = q.vmult(new Vec3(...a.at.map((v, k) => v - a.joint[k])));
    out[a.name] = { pos: [P.pos[0] + j.x + c.x, P.pos[1] + j.y + c.y, P.pos[2] + j.z + c.z], q: [q.x, q.y, q.z, q.w] };
  }
  return out;
};

test('skin stretch: over swing, glide, release, landing and every flight move, no edge stretches past 2.05x its bind length (1.66x away from the shoulder)', () => {
  const V = g.bindPositions, n = V.length / 3, E = new Set();
  for (let i = 0; i < g.indices.length; i += 3) {
    const t = g.indices.slice(i, i + 3);
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) E.add(a < b ? a * n + b : b * n + a);
  }
  // (slivers under a third of the sampling step are marching-tetrahedra artefacts, invisible at any stretch)
  const edges = [...E].map((k) => [Math.floor(k / n), k % n])
    .filter(([a, b]) => Math.hypot(V[3 * a] - V[3 * b], V[3 * a + 1] - V[3 * b + 1], V[3 * a + 2] - V[3 * b + 2]) > STEP / 3);
  const id = new Quaternion(), poses = [Object.fromEntries(ANATOMY.map((a) => [a.name, new Quaternion()]))];
  for (const m of [MOVES.swingStrain, MOVES.swingReach, MOVES.landing, MOVES.release, MOVES.preland, ...Object.values(FLIGHT)].filter(Boolean)) {
    for (const f of [0, .5, 1]) poses.push(sampleMove(m, f * m.duration, id, {}));
  }
  let worst = 0;
  for (const targets of poses) {
    const pose = fk(targets), P = [];
    for (let i = 0; i < n; i++) P.push(skinPoint(g.bind, pose, [V[3 * i], V[3 * i + 1], V[3 * i + 2]], g.skinIndices.slice(4 * i, 4 * i + 4), g.weights.slice(4 * i, 4 * i + 4)));
    for (const [a, b] of edges) {
      const l0 = Math.hypot(V[3 * a] - V[3 * b], V[3 * a + 1] - V[3 * b + 1], V[3 * a + 2] - V[3 * b + 2]);
      worst = Math.max(worst, Math.hypot(...P[a].map((v, k) => v - P[b][k])) / l0);
    }
  }
  assert.ok(worst < 2.05, `worst edge stretch ${worst.toFixed(2)}x`);
});
