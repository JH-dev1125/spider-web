// The physical ragdoll FOLLOWER. It lives in its own Cannon world (its limbs collide with copies of the structure
// boxes and the street), reads the core sphere (player.js) every physics step and never writes it: the core
// trajectory is the same with or without the rig (tests/core.test.js).
//
// Coupling: every rig body gets the same acceleration (mass * a, so the joints carry no load from it): the core's own
// acceleration minus gravity (the rig world applies gravity itself) plus a critically damped spring of the pelvis to
// the core (+ a lift: standing height on roofs, the stance off a wall, the kneel after landing). The muscles
// (ragdoll.js) pose the limbs; contacts plant feet and the landing knee and fist.
import * as C from '../vendor/cannon-es.js';
import { CFG } from './config.js';
import { makeRagdoll, driveRagdoll, ANATOMY } from './ragdoll.js';
import { MOVES, createFlightChain } from './moves.js';
import { makeRng } from './world.js';
import { right } from './street.js';
import { startMove, travelBasis, airtime } from './player.js';

const STRUCT = 2, GROUND = 4;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createRig(p, seed = 1) {
  const world = new C.World({ gravity: new C.Vec3(0, -CFG.gravity, 0) });
  world.broadphase = new C.SAPBroadphase(world);
  world.broadphase.axisIndex = 2;
  world.solver.iterations = CFG.rig.iterations;
  world.solver.tolerance = 1e-7;
  const suit = new C.Material('suit'), foot = new C.Material('sole'), masonry = new C.Material('masonry');
  const ground = new C.Body({ mass: 0, shape: new C.Plane(), collisionFilterGroup: GROUND, material: masonry });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(ground);
  const hard = { contactEquationStiffness: CFG.ropeStiffness, contactEquationRelaxation: 3 };
  world.addContactMaterial(new C.ContactMaterial(suit, masonry, { friction: .4, restitution: .05, ...hard }));
  world.addContactMaterial(new C.ContactMaterial(foot, masonry, { friction: 1.1, restitution: 0, ...hard }));
  const rag = makeRagdoll(world, p, suit, foot);
  return { world, rag, masonry, boxes: new Map(), lift: new C.Vec3(), flight: createFlightChain(makeRng(seed * 7919 + 13)) };
}

export function syncRig(rig, structures) {
  const live = new Set();
  for (const s of structures) {
    live.add(s.id);
    if (rig.boxes.has(s.id)) continue;
    const { min: a, max: b } = s;
    const body = new C.Body({ mass: 0, material: rig.masonry, collisionFilterGroup: STRUCT,
      shape: new C.Box(new C.Vec3((b.x - a.x) / 2, (b.y - a.y) / 2, (b.z - a.z) / 2)),
      position: new C.Vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2) });
    body.structure = s;
    rig.world.addBody(body); rig.boxes.set(s.id, body);
  }
  for (const [id, body] of rig.boxes) if (!live.has(id)) { rig.world.removeBody(body); rig.boxes.delete(id); }
}

// Setup only: carry the whole rig rigidly so the pelvis sits at pos, turned by yaw, every body moving at vel.
export function placeRig(ph, pos, vel, yaw = 0) {
  const o = ph.rag.bodies.pelvis.position.clone(), turn = new C.Quaternion().setFromEuler(0, yaw, 0);
  for (const b of Object.values(ph.rag.bodies)) {
    const r = turn.vmult(b.position.vsub(o));
    b.position.set(pos.x + r.x, pos.y + r.y, pos.z + r.z); b.previousPosition.copy(b.position);
    turn.mult(b.quaternion, b.quaternion);
    b.velocity.set(vel.x, vel.y, vel.z); b.angularVelocity.setZero();
  }
  ph.rig.lift.setZero();
}

// A whole-body angular impulse J about the centre of mass (adds no linear momentum): the tricks' spins.
function angularImpulse(ph, J) {
  const bodies = Object.values(ph.rag.bodies);
  const mass = bodies.reduce((m, b) => m + b.mass, 0);
  const com = bodies.reduce((v, b) => v.vadd(b.position.scale(b.mass / mass)), new C.Vec3());
  const axes = [new C.Vec3(1, 0, 0), new C.Vec3(0, 1, 0), new C.Vec3(0, 0, 1)];
  const I = new C.Mat3();
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
const noLinear = () => {}; // linear move events are gameplay (the core applies them: startTumble)

// The motion layer's state machine (docs/motion-hooks.md), once per step before the muscles.
function motionStep(ph, p) {
  const m = ph.motion;
  if (ph.landing) return; // the landing pose holds
  // a wall run, a roof or a new rope ends any flight move: the gait and the swing own the targets there
  if (m && ph.startPhase === 'play' && (ph.wall || p.roof || ph.rope)) { startMove(ph, null, travelBasis(p)); return; }
  if (m && m.move !== MOVES.roofIdle && (m.sec >= m.move.duration || (m.move === MOVES.roofTumble && ph.startPhase === 'play'))) {
    startMove(ph, null, travelBasis(p)); // the flight chain (ragdoll.js) takes over from here
  }
  // prelanding: falling free toward the street, short of the landing lead time: legs out, root upright
  if (p.alive && ph.startPhase === 'play' && !ph.rope && !ph.wall && !p.roof && p.vel.y < 0 && ph.motion?.move !== MOVES.preland
    && airtime(ph, p) < CFG.moves.landingLeadSec) startMove(ph, MOVES.preland, travelBasis(p));
}

// Stride goals for the feet on a wall run or a roof run (visual: the core does the running). legTargets reaches them.
function gait(ph, p) {
  const st = ph.street, a = st.lat, f = st.axis, fd = st.dir, rt = right(st), root = ph.rag.bodies.pelvis;
  const roofY = p.roof || ph.startPhase === 'idle' ? ph.hero.position.y - CFG.heroRadius : null;
  if (!ph.wall && roofY === null) { ph.gait = null; return; }
  ph.gait ||= { L: { goal: new C.Vec3() }, R: { goal: new C.Vec3() } };
  const speed = Math.abs(ph.hero.velocity[f]), stand = ph.startPhase === 'idle' || speed < .5;
  const period = clamp(4.2 / Math.max(speed, 1), .3, .6), age = ph.rag.time;
  for (const side of ['L', 'R']) {
    const g = ph.gait[side], sd = side === 'L' ? -1 : 1;
    const phase = (age / period + (side === 'R' ? .5 : 0)) % 1, stance = stand || phase < .55;
    const swing = clamp((phase - .55) / .45, 0, 1), lift = stance ? 0 : Math.sin(swing * Math.PI) * .25;
    const fwd = stand ? 0 : stance ? .35 - .7 * phase / .55 : -.35 + .7 * swing;
    if (ph.wall) { g.goal.set(0, root.position.y - ph.wall.n * sd * .1, 0); g.goal[a] = ph.wall.x + ph.wall.n * (.05 + lift); }
    else g.goal.set(root.position.x + rt.x * sd * .1, roofY + .05 + lift, root.position.z + rt.z * sd * .1);
    g.goal[f] = root.position[f] + fd * fwd;
  }
}

// Where the pelvis rides relative to the core: standing height on roofs, the stance off a wall, the kneel.
function liftTarget(ph, p) {
  const out = new C.Vec3();
  if (ph.landing) out.y = CFG.moves.landingPelvisY - CFG.heroRadius;
  else if (p.roof || ph.startPhase === 'idle') out.y = CFG.rig.standY - CFG.heroRadius;
  else if (ph.wall) out[ph.street.lat] = ph.wall.n * (CFG.rig.wallStance - CFG.heroRadius);
  return out;
}

// Both hands on the rope line, a hand's breadth apart (a bounded internal pair: hand against chest).
function gripForces(ph) {
  const b = ph.rag.bodies, pivot = ph.anchor.position, core = ph.hero.position;
  const u = pivot.vsub(core), L = u.length(); if (L < 1e-6) return; u.scale(1 / L, u);
  const hands = ph.wall ? [ph.webSide] : [ph.webSide, ph.webSide === 'L' ? 'R' : 'L'];
  hands.forEach((side, i) => {
    const hand = b['hand' + side], goal = core.vadd(u.scale(CFG.rig.gripReach - .12 * i));
    const F = goal.vsub(hand.position).scale(CFG.rig.gripK).vsub(hand.velocity.vsub(b.chest.velocity).scale(CFG.rig.gripC));
    const n = F.length(); if (n > CFG.rig.gripMax) F.scale(CFG.rig.gripMax / n, F);
    hand.applyForce(F); b.chest.applyForce(F.negate());
  });
}

// Swept centres against expanded structure boxes prevent thin extremities crossing a face in one step.
function sweepContacts(rig, h, near) {
  for (const b of Object.values(rig.rag.bodies)) {
    const radius = Math.max(b.part.startsWith('foot') ? .065 : .16, Math.min(...ANATOMY.find(a => a.name === b.part).size) * 1.1);
    for (const s of near) {
      let entry = 0, exit = 1, axis = null;
      for (const k of ['x', 'y', 'z']) {
        const d = b.velocity[k] * h, lo = s.min[k] - radius, hi = s.max[k] + radius;
        if (Math.abs(d) < 1e-10) { if (b.position[k] < lo || b.position[k] > hi) { entry = 2; break; } continue; }
        const a = (lo - b.position[k]) / d, z = (hi - b.position[k]) / d;
        const n = Math.min(a, z);
        if (n > entry) { entry = n; axis = k; }
        exit = Math.min(exit, Math.max(a, z));
      }
      if (axis && entry <= exit && entry >= 0 && entry < 1) {
        const old = b.velocity[axis], J = new C.Vec3(); J[axis] = -old * (1 - entry) * b.mass;
        b.applyImpulse(J);
      }
    }
  }
}

// One follower step (after the core's): pose, follow, collide.
export function stepRig(ph, p, h) {
  const rig = ph.rig, bodies = Object.values(rig.rag.bodies), pelvis = rig.rag.bodies.pelvis;
  motionStep(ph, p);
  ph.airtimeLeft = airtime(ph, p);
  gait(ph, p);
  driveRagdoll(ph, p, h, noLinear, angularImpulse);
  if (ph.rope && p.alive) gripForces(ph);
  // follow the core: its acceleration (gravity is the rig world's own) + a critically damped pelvis spring
  rig.lift.vadd(liftTarget(ph, p).vsub(rig.lift).scale(Math.min(1, h / CFG.rig.liftSec)), rig.lift);
  const core = ph.hero, w = CFG.rig.followOmega;
  const acc = core.velocity.vsub(ph.prevVel).scale(1 / h); acc.y += CFG.gravity;
  // (the core has already stepped to t + h; the pelvis gets there by this step, so aim its predicted position)
  const e = core.position.vadd(rig.lift).vsub(pelvis.position.vadd(pelvis.velocity.scale(h))), ev = core.velocity.vsub(pelvis.velocity);
  const pull = e.scale(w * w).vadd(ev.scale(2 * w));
  const n = pull.length(); if (n > CFG.rig.followMax) pull.scale(CFG.rig.followMax / n, pull);
  if (acc.length() > CFG.rig.followMax) acc.scale(CFG.rig.followMax / acc.length(), acc); // (a core bounce, a zip kick)
  const a = acc.vadd(pull);
  for (const b of bodies) { b.force.x += b.mass * a.x; b.force.y += b.mass * a.y; b.force.z += b.mass * a.z; }
  // fast limbs need smaller collision steps
  const maxTravel = Math.max(...bodies.map(b => b.velocity.length() * h));
  const steps = Math.max(1, Math.min(8, Math.ceil(maxTravel / .12))), sub = h / steps;
  const loads = bodies.map(b => [b, b.force.clone(), b.torque.clone()]);
  const q = pelvis.position, reach = 2.5 + 8 * maxTravel, near = [];
  for (const { structure: s } of rig.boxes.values()) {
    if (q.x > s.min.x - reach && q.x < s.max.x + reach && q.y > s.min.y - reach && q.y < s.max.y + reach
      && q.z > s.min.z - reach && q.z < s.max.z + reach) near.push(s);
  }
  for (let i = 0; i < steps; i++) {
    if (i) for (const [b, force, torque] of loads) { b.force.copy(force); b.torque.copy(torque); }
    sweepContacts(rig, sub, near);
    rig.world.step(sub);
  }
}
