import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../vendor/cannon-es.js';
import { MOVES, pickTrick, sampleMove, moveImpulses } from '../src/moves.js';
import { CFG } from '../src/config.js';
import { makeRng } from '../src/world.js';
import { ANATOMY, makeRagdoll } from './fixtures/ragdoll.js';

const Q = (e) => new C.Quaternion().setFromEuler(...e, 'YZX');
const near = (a, b, eps = 1e-7) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const identity = new C.Quaternion(), up = new C.Vec3(0, 1, 0);

function limits(targets, label) {
  for (const a of ANATOMY.filter(a => a.parent)) {
    const q = targets[a.parent].conjugate().mult(targets[a.name]);
    if (a.hinge) {
      near(q.y, 0); near(q.z, 0);
      const x = 2 * Math.atan2(q.x * Math.sign(q.w), Math.abs(q.w));
      assert.ok(x >= a.hinge[0] - 1e-7 && x <= a.hinge[1] + 1e-7, `${label} ${a.name}: hinge ${x}`);
    } else {
      const cone = Math.acos(Math.max(-1, Math.min(1, up.dot(q.vmult(up)))));
      const twist = 2 * Math.atan2(Math.abs(q.y), Math.abs(q.w));
      assert.ok(cone <= a.cone + 1e-7, `${label} ${a.name}: cone ${cone}`);
      assert.ok(twist <= a.twist + 1e-7, `${label} ${a.name}: twist ${twist}`);
    }
  }
}

test('all authored keyframes and dense samples are finite, normalized and anatomical', () => {
  assert.ok(!('roll' in MOVES));
  for (const move of Object.values(MOVES)) {
    assert.equal(move.keyframes[0].time, 0);
    assert.equal(move.keyframes.at(-1).time, move.duration);
    assert.ok(move.minAirtime >= move.duration || !move.trick);
    for (const [i, frame] of move.keyframes.entries()) {
      if (i) assert.ok(frame.time > move.keyframes[i - 1].time);
      assert.deepEqual(Object.keys(frame.targets).sort(), ANATOMY.map(a => a.name).sort());
      limits(Object.fromEntries(Object.entries(frame.targets).map(([n, e]) => [n, Q(e)])), move.name);
    }
    for (let i = -1; i <= 101; i++) {
      const t = sampleMove(move, move.duration * i / 100, identity, {});
      for (const q of Object.values(t)) {
        assert.ok([q.x, q.y, q.z, q.w].every(Number.isFinite));
        near(q.x ** 2 + q.y ** 2 + q.z ** 2 + q.w ** 2, 1);
      }
      limits(t, `${move.name}@${i}`);
    }
  }
});

test('sampling composes the basis, reuses output quaternions and does not mutate input', () => {
  const move = MOVES.frontHalfTwist, before = JSON.stringify(move);
  const basis = Q([.3, .7, -.2]), basisBefore = basis.clone();
  const local = sampleMove(move, .3, identity, {});
  const out = Object.fromEntries(ANATOMY.map(a => [a.name, new C.Quaternion()]));
  const held = out.head;
  assert.equal(sampleMove(move, .3, basis, out), out);
  assert.equal(out.head, held);
  for (const a of ANATOMY) {
    const want = basis.mult(local[a.name]), got = out[a.name];
    near(Math.abs(want.x * got.x + want.y * got.y + want.z * got.z + want.w * got.w), 1);
  }
  assert.deepEqual(basis, basisBefore);
  assert.equal(JSON.stringify(move), before);
});

test('weighted seeded trick selection covers ten tricks, excludes last, gates airtime', () => {
  const rng = makeRng(1234), seen = new Set();
  let last = null;
  for (let i = 0; i < 3000; i++) {
    const next = pickTrick(rng, last, 20);
    assert.ok(next.trick && next.cancelOnPress);
    assert.notEqual(next.name, last?.name);
    assert.equal(next.weight, CFG.moves.weights[next.name]);
    seen.add(next.name); last = next;
  }
  assert.equal(seen.size, 10);
  assert.equal(pickTrick(rng, null, 0), null);
  for (let airtime = 0; airtime < 3; airtime += .05) {
    for (let i = 0; i < 30; i++) {
      const next = pickTrick(rng, last?.name, airtime);
      if (next) { assert.ok(next.minAirtime <= airtime); assert.notEqual(next.name, last?.name); }
    }
  }
  for (const move of Object.values(MOVES).filter(m => m.trick)) {
    assert.notEqual(pickTrick(() => 0, move.name, move.minAirtime)?.name, move.name);
  }
});

test('impulses use (t0,t1], fire once across partitions, and never replay after the end', () => {
  for (const move of Object.values(MOVES)) {
    const all = moveImpulses(move, -Number.EPSILON, move.duration);
    const split = [];
    for (let i = 0; i < 120; i++) split.push(...moveImpulses(move, i ? (i - 1) / 60 : -Number.EPSILON, i / 60));
    assert.deepEqual(split, all);
    assert.deepEqual(moveImpulses(move, move.duration, move.duration + 10), []);
    assert.deepEqual(moveImpulses(move, 1, 1), []);
  }
});

// Reconstruct centres from the actual rig's joint pivots, without guessing limb lengths.
function centres(targets) {
  const out = { pelvis: new C.Vec3() };
  for (const a of ANATOMY.filter(a => a.parent)) {
    const parent = ANATOMY.find(p => p.name === a.parent), pivot = new C.Vec3(...a.joint);
    out[a.name] = out[a.parent].vadd(targets[a.parent].vmult(pivot.vsub(new C.Vec3(...parent.at))))
      .vsub(targets[a.name].vmult(pivot.vsub(new C.Vec3(...a.at))));
  }
  return out;
}

test('landing ends with one knee and one fist low, upright torso, then a slight look up', () => {
  const t = sampleMove(MOVES.landing, MOVES.landing.duration, identity, {}), p = centres(t);
  const kneeL = p.thighL.vadd(t.thighL.vmult(new C.Vec3(0, -.22, 0)));
  const kneeR = p.thighR.vadd(t.thighR.vmult(new C.Vec3(0, -.22, 0)));
  assert.ok(kneeL.y < kneeR.y - .25);
  // Translate the target rig onto the plane using its lowest oriented box.
  const bottom = a => {
    let extent = 0;
    for (let i = 0; i < 3; i++) {
      const axis = new C.Vec3(); axis[['x','y','z'][i]] = a.size[i];
      extent += Math.abs(t[a.name].vmult(axis).y);
    }
    return p[a.name].y - extent;
  };
  const floor = Math.min(...ANATOMY.map(bottom));
  assert.ok(kneeL.y - floor < .12, `knee gap ${kneeL.y-floor}`);
  const fist = bottom(ANATOMY.find(a => a.name === 'handL'));
  assert.ok(fist - floor < .12, `fist gap ${fist-floor}`);
  assert.ok(p.handR.y > p.handL.y + .25);
  assert.ok(Math.acos(up.dot(t.chest.vmult(up))) < 35 * Math.PI / 180);
  const down = sampleMove(MOVES.landing, .25, identity, {}).head.vmult(new C.Vec3(0, 0, 1));
  assert.ok(t.head.vmult(new C.Vec3(0, 0, 1)).y > down.y);
});

test('strain targets extend elbows and keep joint limits', () => {
  const reach = sampleMove(MOVES.swingReach, MOVES.swingReach.duration, identity, {});
  const strain = sampleMove(MOVES.swingStrain, MOVES.swingStrain.duration, identity, {});
  for (const side of ['L', 'R']) {
    const bend = t => { const q = t['upperArm' + side].conjugate().mult(t['forearm' + side]); return Math.abs(2 * Math.atan2(q.x, q.w)); };
    assert.ok(bend(strain) < bend(reach));
  }
});

test('fixture: one second of inertia-scaled PD chasing every move stays finite, bounded and conserves linear momentum', () => {
  for (const move of Object.values(MOVES)) {
    const world = new C.World({ gravity: new C.Vec3() }); world.solver.iterations = 28;
    const r = makeRagdoll(world, { pos: { x: 0, y: 20, z: 0 }, vel: { x: 2, y: 0, z: 3 } });
    const momentum = () => Object.values(r.bodies).reduce((p, b) => p.vadd(b.velocity.scale(b.mass)), new C.Vec3());
    const initial = momentum(); let maxGap = 0;
    for (let i = 0; i < 120; i++) {
      sampleMove(move, i / 120, identity, r.targets);
      for (const j of r.joints) {
        const desired = r.targets[j.a.parent].conjugate().mult(r.targets[j.a.name]);
        const target = j.parent.quaternion.mult(desired), error = target.mult(j.body.quaternion.conjugate());
        const w = j.body.angularVelocity.vsub(j.parent.angularVelocity), sign = error.w < 0 ? -1 : 1;
        // The WIP driver uses the same gains for a 24 kg chest and a .6 kg hand.
        // Scale this isolated smoke-test controller to inertia (12 rad/s response).
        const inertia = Math.min(...j.body.inertia.toArray(), ...j.parent.inertia.toArray());
        const kp = 144 * inertia, kd = 24 * inertia, limit = 200;
        const torque = new C.Vec3(2 * sign * error.x * kp - kd * w.x, 2 * sign * error.y * kp - kd * w.y, 2 * sign * error.z * kp - kd * w.z);
        if (torque.length() > limit) torque.scale(limit / torque.length(), torque);
        j.body.torque.vadd(torque, j.body.torque); j.parent.torque.vsub(torque, j.parent.torque);
      }
      world.step(1 / 120);
      for (const b of Object.values(r.bodies)) {
        assert.ok([...b.position.toArray(), ...b.velocity.toArray(), ...b.quaternion.toArray()].every(Number.isFinite), move.name);
        assert.ok(b.velocity.length() < 40 && b.angularVelocity.length() < 150, `${move.name} step ${i} ${b.part}: v=${b.velocity.length()} w=${b.angularVelocity.length()}`);
      }
      for (const j of r.joints) maxGap = Math.max(maxGap, j.parent.pointToWorldFrame(j.joint.pivotA).distanceTo(j.body.pointToWorldFrame(j.joint.pivotB)));
    }
    assert.ok(maxGap < .12, `${move.name}: joint separation ${maxGap}`);
    assert.ok(momentum().distanceTo(initial) < 1e-5, `${move.name}: muscles changed linear momentum`);
  }
});
