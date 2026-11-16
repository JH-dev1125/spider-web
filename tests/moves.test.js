import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../vendor/cannon-es.js';
import { MOVES, pickTrick, sampleMove, moveImpulses, FLIGHT, pickFlight, createFlightChain } from '../src/moves.js';
import { CFG } from '../src/config.js';
import { makeRng } from '../src/world.js';
import { ANATOMY, makeRagdoll } from '../src/ragdoll.js';

const Q = (e) => new C.Quaternion().setFromEuler(...e, 'YZX');
const near = (a, b, eps = 1e-7) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const identity = new C.Quaternion(), up = new C.Vec3(0, 1, 0);
const allMoves = () => Object.values({ ...MOVES, ...FLIGHT });

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
  for (const move of allMoves()) {
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
  for (const move of allMoves()) {
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
  assert.ok(fist - floor < .14, `fist gap ${fist-floor}`); // (the table alone; on the street, contact closes it: integration.test)
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

// Same rigid-body angular impulse as the integration hook: orbital velocities
// matter as well as each box's spin, and their mass-weighted sum must be zero.
function angularImpulse(rag, J) {
  const bodies = Object.values(rag.bodies), mass = bodies.reduce((m, b) => m + b.mass, 0);
  const com = bodies.reduce((v, b) => v.vadd(b.position.scale(b.mass / mass)), new C.Vec3());
  const axes = [new C.Vec3(1, 0, 0), new C.Vec3(0, 1, 0), new C.Vec3(0, 0, 1)], I = new C.Mat3();
  for (let col = 0; col < 3; col++) {
    const axis = axes[col], total = new C.Vec3();
    for (const b of bodies) {
      const r = b.position.vsub(com), local = b.quaternion.conjugate().vmult(axis);
      local.set(local.x * b.inertia.x, local.y * b.inertia.y, local.z * b.inertia.z);
      total.vadd(b.quaternion.vmult(local), total);
      total.vadd(r.cross(axis.cross(r)).scale(b.mass), total);
    }
    I.e(0, col, total.x); I.e(1, col, total.y); I.e(2, col, total.z);
  }
  const omega = I.solve(J);
  for (const b of bodies) {
    b.applyImpulse(omega.cross(b.position.vsub(com)).scale(b.mass));
    b.angularVelocity.vadd(omega, b.angularVelocity);
  }
}

test('fixture: full moves with spin impulses and inertia-scaled PD stay stable and conserve linear momentum', () => {
  for (const move of allMoves()) for (const mirror of [-1, 1]) for (const spins of [false, true]) {
    const rate = mirror < 0 ? .8 : 1.2;
    const world = new C.World({ gravity: new C.Vec3() }); world.solver.iterations = 28;
    const r = makeRagdoll(world, { pos: { x: 0, y: 20, z: 0 }, vel: { x: 2, y: 0, z: 3 } });
    const momentum = () => Object.values(r.bodies).reduce((p, b) => p.vadd(b.velocity.scale(b.mass)), new C.Vec3());
    const initial = momentum(), from = sampleMove(MOVES.roofIdle, 0, identity, {}); let maxGap = 0, turns = 0;
    for (let i = 0; i < Math.ceil(Math.max(1, move.duration / rate) * 120); i++) {
      for (const e of moveImpulses(move, i ? (i - 1) * rate / 120 : -Number.EPSILON, i * rate / 120, mirror)) {
        if (spins && e.angular) angularImpulse(r, new C.Vec3(...e.angular));
      }
      const frame = move.impulses.some(e => e.angular) ? r.bodies.pelvis.quaternion : identity;
      sampleMove(move, i * rate / 120, frame, r.targets, { mirror, from, alpha: Math.min(1, i / 120 / .25) });
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
      turns += r.bodies.pelvis.angularVelocity.x / 120 / (2 * Math.PI);
      for (const b of Object.values(r.bodies)) {
        assert.ok([...b.position.toArray(), ...b.velocity.toArray(), ...b.quaternion.toArray()].every(Number.isFinite), move.name);
        assert.ok(b.velocity.length() < 40 && b.angularVelocity.length() < 150, `${move.name} step ${i} ${b.part}: v=${b.velocity.length()} w=${b.angularVelocity.length()}`);
      }
      for (const j of r.joints) maxGap = Math.max(maxGap, j.parent.pointToWorldFrame(j.joint.pivotA).distanceTo(j.body.pointToWorldFrame(j.joint.pivotB)));
    }
    // External spin events add constraint load; retain the original .12 m
    // pose-only bound and allow .13 m with the unchanged legacy 95 N m s spin.
    assert.ok(maxGap < (spins ? .13 : .12), `${move.name} mirror=${mirror} rate=${rate}: joint separation ${maxGap}`);
    if (move.name === 'frontRolls' && spins) assert.ok(-turns >= 2 && -turns <= 3.25, `front rolls: ${-turns} turns at rate ${rate}`);
    assert.ok(momentum().distanceTo(initial) < 1e-5, `${move.name}: muscles changed linear momentum`);
  }
});

test('flight table adds sixteen distinct moves and reuses all ten tricks', () => {
  assert.ok(FLIGHT, 'FLIGHT table is missing');
  const fresh = Object.values(FLIGHT).filter(m => !MOVES[m.name]);
  assert.ok(fresh.length >= 16);
  assert.equal(new Set(fresh.map(m => JSON.stringify(m.keyframes))).size, fresh.length);
  for (const m of Object.values(MOVES).filter(m => m.trick)) assert.equal(FLIGHT[m.name], m);
  for (const m of Object.values(FLIGHT)) {
    assert.ok(m.duration >= .6 && m.duration <= 1.8, m.name);
    assert.ok(m.cancelOnPress && m.weight > 0, m.name);
  }
});

test('five-minute seeded flight has no idle, no repeat within three, varied rates and mirrors', () => {
  assert.equal(typeof createFlightChain, 'function');
  const chain = createFlightChain(makeRng(431)), ctx = { airborne: true, airtimeLeft: 20, speed: 15, vy: 0 };
  const seen = new Set(), mirrors = new Set(), rates = new Set(), history = [];
  let previous, idle = 0, longestIdle = 0, elapsed = 0;
  for (let i = 0; i < 300 * 120; i++) {
    const f = chain.step(1 / 120, ctx);
    idle = f.move ? 0 : idle + 1 / 120; longestIdle = Math.max(longestIdle, idle);
    if (f.move !== previous) {
      if (previous) assert.ok(elapsed >= .6 && elapsed <= 1.8 + 1 / 120, `${previous.name}: ${elapsed}`);
      assert.ok(!history.includes(f.move.name));
      history.push(f.move.name); if (history.length > 3) history.shift();
      seen.add(f.move.name); mirrors.add(f.mirror); rates.add(f.rate);
      previous = f.move; elapsed = 0;
    }
    elapsed += 1 / 120;
    assert.ok(f.t >= 0 && f.t <= f.move.duration);
    assert.ok(Math.abs(f.rate - 1) >= .1 - 1e-10 && Math.abs(f.rate - 1) <= .2 + 1e-10);
    assert.ok(f.t0 < f.t || f.t === 0);
  }
  assert.ok(seen.size >= 16, `only ${seen.size} moves`);
  assert.deepEqual([...mirrors].sort(), [-1, 1]); assert.ok(rates.size > 20);
  assert.ok(longestIdle <= .4);
});

test('flight selection respects history and worst-case slow airtime, and weights dives versus apexes', () => {
  assert.equal(typeof pickFlight, 'function');
  const rng = makeRng(72), history = ['pencilDive', 'superman', 'twistingDive'];
  for (let air = 0; air < 3; air += .05) {
    for (let i = 0; i < 20; i++) {
      const m = pickFlight(rng, history, air, 30, -15);
      if (m) { assert.ok(!history.includes(m.name)); assert.ok(Math.max(m.minAirtime, m.duration / .8 + .3) <= air + 1e-9); }
    }
  }
  assert.equal(pickFlight(rng, null, .2, 0, -5), null);
  const diveNames = new Set(['pencilDive', 'superman', 'twistingDive']);
  const apexNames = new Set(['arabesque', 'attitudeTurn', 'thinker', 'cityLounge']);
  const counts = (speed, vy) => {
    const rng = makeRng(333); let dive = 0, apex = 0;
    for (let i = 0; i < 10000; i++) {
      const m = pickFlight(rng, null, 20, speed, vy);
      dive += diveNames.has(m.name); apex += apexNames.has(m.name);
    }
    return { dive, apex };
  };
  const dive = counts(35, -20), apex = counts(5, 0);
  assert.ok(dive.dive > apex.dive * 2); assert.ok(apex.apex > dive.apex * 2);
});

test('press, rope, landing and insufficient airtime interrupt the chain immediately', () => {
  assert.equal(typeof createFlightChain, 'function');
  const chain = createFlightChain(makeRng(19)), ctx = { airborne: true, airtimeLeft: 20, speed: 20, vy: 0 };
  for (const stop of [{ pressed: true }, { rope: true }, { preland: true }, { airborne: false }, { airtimeLeft: .2 }]) {
    assert.ok(chain.step(.01, ctx).move);
    assert.equal(chain.step(.01, { ...ctx, ...stop }).move, null);
  }
  assert.throws(() => chain.step(-1, ctx), RangeError);
  assert.throws(() => chain.step(NaN, ctx), RangeError);
});

test('mirrored flight samples and joint-space crossfades remain anatomical; impulses reflect as axial vectors', () => {
  assert.ok(FLIGHT);
  const chain = createFlightChain(makeRng(87)), ctx = { airborne: true, airtimeLeft: 20, speed: 18, vy: -4 };
  let last, from, out = {};
  for (let i = 0; i < 60 * 120; i++) {
    const f = chain.step(1 / 120, ctx);
    if (f.move !== last) { from = Object.fromEntries(Object.entries(out).map(([n, q]) => [n, q.clone()])); last = f.move; }
    sampleMove(f.move, f.t, identity, out, { mirror: f.mirror, from, alpha: f.blend });
    limits(out, `${f.move.name} blend ${f.blend}`);
  }
  for (const m of Object.values(FLIGHT)) {
    const a = sampleMove(m, m.duration / 2, identity, {});
    const b = sampleMove(m, m.duration / 2, identity, {}, { mirror: -1 });
    for (const n of Object.keys(a)) {
      const other = n.endsWith('L') ? n.slice(0, -1) + 'R' : n.endsWith('R') ? n.slice(0, -1) + 'L' : n;
      near(b[n].x, a[other].x); near(b[n].y, -a[other].y); near(b[n].z, -a[other].z); near(b[n].w, a[other].w);
    }
    const original = JSON.stringify(m.impulses), reflected = moveImpulses(m, -Number.EPSILON, m.duration, -1);
    reflected.forEach((e, i) => {
      if (e.angular) assert.deepEqual(e.angular, [m.impulses[i].angular[0], -m.impulses[i].angular[1], -m.impulses[i].angular[2]]);
    });
    assert.equal(JSON.stringify(m.impulses), original);
  }
});
