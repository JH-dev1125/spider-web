import * as C from '../vendor/cannon-es.js';
import { CFG } from './config.js';
import { yawOf, right } from './street.js';
import { MOVES, sampleMove, moveImpulses } from './moves.js';

// Rest centres in metres, pelvis origin, +y head-up, +z chest/forward. Shared by physics and skin.
export const ANATOMY = [
  { name: 'pelvis', at: [0, 0, 0], size: [.145, .125, .105], mass: 12 },
  { name: 'chest', at: [0, .32, 0], size: [.205, .235, .12], mass: 24, parent: 'pelvis', joint: [0, .1, 0], cone: .45, twist: .4 },
  { name: 'head', at: [0, .72, 0], size: [.105, .145, .11], mass: 5, parent: 'chest', joint: [0, .565, 0], cone: .65, twist: .8 },
  ...[-1, 1].flatMap(sd => {
    const s = sd < 0 ? 'L' : 'R';
    return [
      { name: 'upperArm' + s, at: [sd * .24, .345, 0], size: [.058, .155, .06], mass: 2, parent: 'chest', joint: [sd * .24, .5, 0], cone: 2.9, twist: 1.4 },
      { name: 'forearm' + s, at: [sd * .24, .045, 0], size: [.046, .145, .047], mass: 1.4, parent: 'upperArm' + s, joint: [sd * .24, .19, 0], hinge: [-2.5, .05] },
      { name: 'hand' + s, at: [sd * .24, -.16, 0], size: [.048, .07, .035], mass: .6, parent: 'forearm' + s, joint: [sd * .24, -.1, 0], cone: .65, twist: .55 },
      { name: 'thigh' + s, at: [sd * .09, -.32, 0], size: [.085, .22, .078], mass: 7, parent: 'pelvis', joint: [sd * .09, -.1, 0], cone: 1.9, twist: .6 },
      { name: 'shin' + s, at: [sd * .09, -.735, 0], size: [.055, .195, .052], mass: 3, parent: 'thigh' + s, joint: [sd * .09, -.54, 0], hinge: [.02, 2.5] },
      { name: 'foot' + s, at: [sd * .09, -.975, .055], size: [.062, .045, .13], mass: .5, parent: 'shin' + s, joint: [sd * .09, -.93, 0], cone: .7, twist: .35 },
    ];
  }),
];
const V = (a) => new C.Vec3(...a);
const DOWN = new C.Vec3(0, -1, 0), UP = new C.Vec3(0, 1, 0);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function makeRagdoll(world, p, material, footMaterial) {
  const bodies = {}, joints = [];
  for (const a of ANATOMY) {
    const b = new C.Body({ mass: a.mass, material: a.name.startsWith('foot') ? footMaterial : material,
      position: new C.Vec3(p.pos.x + a.at[0], p.pos.y + a.at[1], p.pos.z + a.at[2]),
      velocity: V([p.vel.x, p.vel.y, p.vel.z]), linearDamping: 0, angularDamping: .3,
      // shortcut: self-collision is disabled for the whole hero; add non-adjacent pairs if close grappling is introduced.
      collisionFilterGroup: 1, collisionFilterMask: 2 | 4, allowSleep: false });
    // Boxes give reliable narrow-phase contacts at high speed; the skin rounds their silhouette.
    b.addShape(new C.Box(V(a.size)));
    // Inertia floor (a standard ragdoll stabiliser): a 0.6 kg hand hanging the whole body off a stiff rope jitters
    // in the iterative solver at its true inertia; raising it changes the spin of light segments only, not the motion.
    const F = CFG.inertiaFloor;
    { b.inertia.set(Math.max(F, b.inertia.x), Math.max(F, b.inertia.y), Math.max(F, b.inertia.z));
      b.invInertia.set(1 / b.inertia.x, 1 / b.inertia.y, 1 / b.inertia.z); b.updateInertiaWorld(true); }
    b.part = a.name;
    world.addBody(b); bodies[a.name] = b;
    if (a.parent) {
      const parent = bodies[a.parent], pivot = V(a.joint);
      const opts = { pivotA: pivot.vsub(V(ANATOMY.find(x => x.name === a.parent).at)),
        pivotB: pivot.vsub(V(a.at)), maxForce: 4e4, collideConnected: false };
      let joint;
      if (a.hinge) {
        joint = new C.HingeConstraint(parent, b, { ...opts, axisA: new C.Vec3(1, 0, 0), axisB: new C.Vec3(1, 0, 0) });
        // Cannon hinges leave twist free: an extra cone equation is the anatomical flexion stop.
        const stop = new C.ConeTwistConstraint(parent, b, { ...opts, angle: (a.hinge[1] - a.hinge[0]) / 2 });
        const mid = (a.hinge[0] + a.hinge[1]) / 2;
        stop.axisA.set(0, Math.cos(mid), Math.sin(mid)); stop.axisB.copy(UP);
        joint.equations.push(stop.coneEquation);
        const hingeUpdate = joint.update.bind(joint);
        joint.update = () => { hingeUpdate(); stop.update(); };
      } else joint = new C.ConeTwistConstraint(parent, b, { ...opts, axisA: UP, axisB: UP, angle: a.cone, twistAngle: a.twist });
      for (const eq of joint.equations) eq.setSpookParams(1e8, 4, CFG.physicsStep);
      world.addConstraint(joint); joints.push({ a, parent, body: b, joint, motor: motorOn(world, parent, b) });
    }
  }
  // the whole rig's inertia about the pelvis (smallest principal axis, roughly): the root muscle's scale
  const rootInertia = Object.values(bodies).reduce((s, b) => s + minInertia(b) + b.mass * b.position.distanceSquared(bodies.pelvis.position), 0) / 2;
  // the root muscle: the pelvis's world orientation against a static frame (the upright reference)
  const frame = new C.Body({ mass: 0, collisionFilterGroup: 0, collisionFilterMask: 0 }); world.addBody(frame);
  return { bodies, joints, rootInertia, root: motorOn(world, frame, bodies.pelvis), targets: Object.fromEntries(ANATOMY.map(a => [a.name, new C.Quaternion()])), time: 0 };
}

// Muscles are VELOCITY SERVOS solved inside the constraint solver (three RotationalMotorEquations per joint, one per
// world axis): the child's angular velocity relative to its parent is driven to omega * (its orientation error), up to a
// torque cap. Solved implicitly with the joints, they stay stable at any stiffness, hold a pose under load (the error
// decays at rate omega whatever the load, until the cap) and still give way on impacts. No transforms are assigned.
const minInertia = (b) => Math.min(b.inertia.x, b.inertia.y, b.inertia.z);
const AXES = [new C.Vec3(1, 0, 0), new C.Vec3(0, 1, 0), new C.Vec3(0, 0, 1)];
function motorOn(world, parent, body) {
  const c = new C.Constraint(parent, body);
  for (const axis of AXES) {
    const eq = new C.RotationalMotorEquation(parent, body, 0);
    eq.axisA.copy(axis); eq.axisB.copy(axis); c.equations.push(eq);
  }
  c.update = () => {};
  world.addConstraint(c);
  return c;
}
const err = new C.Vec3();
function muscle(motor, body, target, omega, limit, maxSpeed = 30) {
  const e = target.mult(body.quaternion.conjugate()); // world rotation still to go
  if (e.w < 0) { e.x = -e.x; e.y = -e.y; e.z = -e.z; e.w = -e.w; }
  const s = Math.hypot(e.x, e.y, e.z), angle = 2 * Math.atan2(s, e.w);
  err.set(e.x, e.y, e.z).scale(s > 1e-9 ? Math.min(maxSpeed, omega * angle) / s : 0, err);
  motor.equations.forEach((eq, k) => {
    eq.enabled = limit > 0;
    eq.targetVelocity = -err[['x', 'y', 'z'][k]]; // (the equation drives parent minus child)
    eq.maxForce = limit; eq.minForce = -limit;
  });
}
const relax = (motor) => { for (const eq of motor.equations) eq.enabled = false; };

// A rotation whose local x, y, z axes are the given orthonormal world vectors.
function fromAxes(q, x, y, z) {
  const tr = x.x + y.y + z.z;
  if (tr > 0) { const s = .5 / Math.sqrt(tr + 1); q.set((y.z - z.y) * s, (z.x - x.z) * s, (x.y - y.x) * s, .25 / s); }
  else if (x.x > y.y && x.x > z.z) { const s = 2 * Math.sqrt(1 + x.x - y.y - z.z); q.set(.25 * s, (y.x + x.y) / s, (z.x + x.z) / s, (y.z - z.y) / s); }
  else if (y.y > z.z) { const s = 2 * Math.sqrt(1 + y.y - x.x - z.z); q.set((y.x + x.y) / s, .25 * s, (z.y + y.z) / s, (z.x - x.z) / s); }
  else { const s = 2 * Math.sqrt(1 + z.z - x.x - y.y); q.set((z.x + x.z) / s, (z.y + y.z) / s, .25 * s, (x.y - y.x) / s); }
  return q.normalize();
}
// Two-link arm reach toward goal: the upper arm aims at the elbow (placed out and back), twisted so the elbow hinge
// (local x) bends the forearm onto the goal; the forearm is the upper arm turned about that hinge. Hinge-consistent.
function armTargets(b, t, side, goal) {
  const sd = side === 'L' ? -1 : 1, sh = b.chest.pointToWorldFrame(new C.Vec3(sd * .24, .18, 0));
  const d = goal.vsub(sh), dist = clamp(d.length(), .12, .64); d.normalize();
  const L1 = .31, L2 = .35, a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
  const out = b.chest.quaternion.vmult(new C.Vec3(sd, 0, -.6)); out.vsub(d.scale(out.dot(d)), out); out.normalize();
  const elbow = sh.vadd(d.scale(a)).vadd(out.scale(Math.sqrt(Math.max(.0001, L1 * L1 - a * a))));
  const y = sh.vsub(elbow); y.normalize(); // the upper arm hangs along its local -y
  const z = sh.vadd(d.scale(dist)).vsub(elbow); z.vsub(y.scale(z.dot(y)), z); z.normalize(); // the forearm bends to +z
  const x = y.cross(z);
  fromAxes(t['upperArm' + side], x, y, z);
  const bend = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1));
  t['upperArm' + side].mult(new C.Quaternion().setFromAxisAngle(new C.Vec3(1, 0, 0), -bend), t['forearm' + side]);
  t['hand' + side].copy(t['forearm' + side]);
}

function limbTarget(target, from, to) {
  const d = to.vsub(from); d.normalize(); target.setFromVectors(DOWN, d);
}

// Two-link reach chooses muscle orientations, never joint positions. Contact/constraints decide actual motion.
function legTargets(rag, side, goal, basis) {
  const b = rag.bodies, hip = b.pelvis.pointToWorldFrame(new C.Vec3(side === 'L' ? -.09 : .09, -.1, 0));
  const d = goal.vsub(hip), dist = clamp(d.length(), .08, .815); d.normalize();
  const a = (.44 ** 2 - .39 ** 2 + dist * dist) / (2 * dist);
  const bend = basis.vmult(new C.Vec3(0, 0, 1)); bend.vsub(d.scale(bend.dot(d)), bend); bend.normalize();
  const knee = hip.vadd(d.scale(a)).vadd(bend.scale(Math.sqrt(Math.max(.001, .44 ** 2 - a * a))));
  limbTarget(rag.targets['thigh' + side], hip, knee);
  limbTarget(rag.targets['shin' + side], knee, goal);
  rag.targets['foot' + side].copy(basis);
}

const strainTargets = {};
const copyTargets = (targets) => Object.fromEntries(Object.entries(targets).map(([n, q]) => [n, q.clone()]));
// impulse(ph, dv) / angularImpulse(ph, J): player.js's whole-body impulses, passed in (no import cycle).
// Muscles stay on after death: the landing pose is held by them (docs/motion-hooks.md C).
export function driveRagdoll(ph, p, h, impulse, angularImpulse) {
  const r = ph.rag, b = r.bodies, t = r.targets;
  r.time += h;
  r.modeTime = r.mode === p.mode ? (r.modeTime || 0) + h : 0; r.mode = p.mode;
  // Every pose is authored facing +z; `yaw` turns it to face down the current street (street.js).
  const st = ph.street, yaw = new C.Quaternion(), basis = new C.Quaternion();
  if (st) yaw.setFromAxisAngle(UP, yawOf(st));
  if (ph.wall) {
    const rt = st ? right(st) : { x: 1, z: 0 }, n = ph.wall.n * (st ? rt[st.lat] : 1); // the face normal, body-local x
    basis.setFromAxisAngle(new C.Vec3(0, 0, 1), -n * Math.PI / 2);
    const balance = new C.Quaternion(); balance.setFromEuler(-.3, 0, 0); basis.mult(balance, basis);
  }
  else if (!p.roof && p.anchor) {
    const d = ph.anchor.position.vsub(b.pelvis.position); d.normalize();
    const up = new C.Vec3(d.x * .4, Math.max(.6, d.y), d.z * .4); up.normalize();
    const tilt = new C.Quaternion(); tilt.setFromVectors(UP, up); tilt.mult(yaw, basis); // yaw first, then lean up the rope
  }
  if (!ph.wall && !p.roof && !p.anchor) {
    if (p.mode === 'glide') basis.setFromEuler(.35, 0, 0);
  }
  if (ph.climb) { // straight up the facade: upright, chest to the glass, leaning back a little off it
    const n = ph.climb.n, lat = st?.lat || 'x';
    basis.setFromEuler(-.12, Math.atan2(lat === 'x' ? -n : 0, lat === 'z' ? -n : 0), 0, 'YZX');
  } else if (ph.wall || p.roof || !p.anchor) yaw.mult(basis, basis);
  for (const a of ANATOMY) t[a.name].copy(basis);
  for (const side of ['L', 'R']) {
    const sd = side === 'L' ? -1 : 1;
    const upper = t['upperArm' + side], lower = t['forearm' + side];
    const isWeb = ph.rope && (side === ph.webSide || !ph.wall); // two hands on the line (one on a wall run)
    if (isWeb) {
      // Both hands on the line above his head (the shooting hand on top, the other 0.12 m below it): two-link reach
      // with the elbows out and back (rig.js gripForces holds the hands there; the rope is drawn from them).
      const u = ph.anchor.position.vsub(b.pelvis.position); u.normalize();
      const goal = b.pelvis.position.vadd(u.scale(CFG.rig.gripReach - (side === ph.webSide ? 0 : .12)));
      armTargets(b, t, side, goal);
    } else if (ph.climb) { // hand over hand up the glass, opposite to the stride
      const s = Math.sin((r.time / .36 + (side === 'R' ? .5 : 0)) * 2 * Math.PI), q = new C.Quaternion();
      q.setFromEuler(-1.9 - .7 * s, 0, sd * .25); basis.mult(q, upper);
      q.setFromEuler(-.6 + .4 * s, 0, 0); upper.mult(q, lower); t['hand' + side].copy(lower);
    } else {
      const q = new C.Quaternion();
      q.setFromEuler(-.25, 0, sd * (ph.wall || p.roof ? .25 : 1.05)); basis.mult(q, upper);
      q.setFromEuler(-.35, 0, 0); upper.mult(q, lower); t['hand' + side].copy(lower);
    }
    if (ph.wall || p.roof || ph.climb) {
      const gait = ph.gait?.[side];
      if (gait) legTargets(r, side, gait.goal, basis);
    } else if (p.mode === 'tuck' || p.mode === 'walljump') {
      const q = new C.Quaternion(); q.setFromEuler(-1.1, 0, sd * .1); basis.mult(q, t['thigh' + side]);
      q.setFromEuler(1.9, 0, 0); t['thigh' + side].mult(q, t['shin' + side]); t['foot' + side].copy(t['shin' + side]);
    } else {
      const q = new C.Quaternion(); q.setFromEuler(-.2, 0, sd * .12); basis.mult(q, t['thigh' + side]);
      q.setFromEuler(.35, 0, 0); t['thigh' + side].mult(q, t['shin' + side]); t['foot' + side].copy(t['shin' + side]);
    }
  }
  if (ph.rope && !ph.wall) {
    // the swing strain (moves.js): chest crunch, head duck and knee tuck with the rope's load; the arms keep their reach
    sampleMove(MOVES.swingStrain, (ph.load || 0) * MOVES.swingStrain.duration, basis, strainTargets);
    for (const n of ['chest', 'head', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR']) t[n].copy(strainTargets[n]);
  }
  // The motion layer: a move's targets replace these (tricks, release, zip yank, landing, the rooftop idle/tumble).
  const motion = ph.motion;
  if (motion) {
    const prev = motion.sec, m = motion.mirror || 1;
    motion.sec = Math.max(0, prev) + h;
    for (const e of moveImpulses(motion.move, prev, motion.sec, m)) {
      if (e.linear) impulse(ph, motion.basis.vmult(new C.Vec3(...e.linear)));
      if (e.angular) angularImpulse(ph, motion.basis.vmult(new C.Vec3(...e.angular)));
    }
    const spinning = motion.move.impulses.some(e => e.angular);
    const sec = motion.move === MOVES.roofIdle ? motion.sec % motion.move.duration : motion.sec;
    sampleMove(motion.move, sec, spinning ? b.pelvis.quaternion : motion.basis, t, { mirror: m });
  }
  if (ph.targetBlend) {
    const blend = ph.targetBlend;
    blend.sec += h;
    const u = Math.min(1, blend.sec / CFG.moves.blendSec);
    for (const name of Object.keys(t)) blend.from[name].slerp(t[name], u, t[name]);
    if (u === 1) ph.targetBlend = null;
  }
  // The continuous flight chain (moves.js createFlightChain, docs/motion-hooks.md): airborne with no rope and nothing
  // else owning the body, link after link with no glide between; a press cancels it, preland overrides it.
  let flightSpinning = false;
  if (ph.flight) {
    const pressed = ph.flightPressed || ph.webOut; // (a web in flight holds the chain off: the shot owns the arms)
    ph.flightPressed = false;
    const free = p.alive && !ph.rope && !ph.wall && !ph.climb && !p.roof && !ph.landing && !ph.motion && ph.startPhase === 'play';
    const f = ph.flight.step(h, { airborne: free, rope: !!ph.rope, pressed, preland: !!ph.landing,
      airtimeLeft: ph.airtimeLeft ?? 0, speed: Math.hypot(p.vel.x, p.vel.y, p.vel.z), vy: p.vel.y });
    flightSpinning = !!f.move?.impulses.some(e => e.angular);
    ph.flightMove = f.move?.name ?? null;
    if (f.move) {
      if (f.started) { ph.flightFrom = ph.flightLast || copyTargets(t); ph.flightBasis = basis.clone(); ph.targetBlend = null; }
      sampleMove(f.move, f.t, flightSpinning ? b.pelvis.quaternion : ph.flightBasis, t, { mirror: f.mirror, from: ph.flightFrom, alpha: f.blend });
      for (const e of moveImpulses(f.move, f.t0, f.t, f.mirror)) {
        if (e.linear) impulse(ph, ph.flightBasis.vmult(new C.Vec3(...e.linear)));
        if (e.angular) angularImpulse(ph, ph.flightBasis.vmult(new C.Vec3(...e.angular)));
      }
      ph.flightPrelandSec = 0;
    } else if (free && !pressed) { // no link fits the airtime left: straight into the preland pose, never a static glide
      if (!ph.flightPrelandSec) ph.flightFrom = ph.flightLast || copyTargets(t);
      ph.flightPrelandSec += h; ph.targetBlend = null; ph.flightMove = 'preland';
      sampleMove(MOVES.preland, ph.flightPrelandSec, basis, t, { from: ph.flightFrom, alpha: Math.min(1, ph.flightPrelandSec / .25) });
    } else { ph.flightPrelandSec = 0; if (free && ph.webOut) ph.flightMove = 'shoot'; } // (aiming a web: not idle)
    ph.glideIdle = free && !ph.flightMove ? (ph.glideIdle || 0) + h : 0; // free but nothing chained (tests bound it)
    ph.flightLast = copyTargets(t);
  }
  // Balance assistance supplies an upright reference (t.pelvis); joints still react against one another. Off while a
  // move spins him (it would fight the flip); stiff for the landing hold and on walls and roofs.
  const spinning = motion && motion.sec < motion.move.duration && motion.move.impulses.some(e => e.angular);
  const firm = ph.landing || ph.wall || p.roof || ph.climb || ph.startPhase !== 'play', M = CFG.muscle;
  if (!spinning && !flightSpinning) muscle(r.root, b.pelvis, t.pelvis, firm ? M.rootFirm[0] : M.root[0], firm ? M.rootFirm[1] : M.root[1]);
  else relax(r.root);
  const stiff = ph.landing && ph.landing.sec < CFG.moves.landingStiffSec ? 1.4 : 1; // the impact, then the hold
  for (const j of r.joints) {
    const desired = t[j.a.parent].conjugate().mult(t[j.a.name]);
    const target = j.parent.quaternion.mult(desired); // (the parent as it is now: the error is the joint's own)
    const g = M[j.a.name.replace(/[LR]$/, '')]; // [omega rad/s, torque cap N m] per segment (CFG.muscle)
    muscle(j.motor, j.body, target, g[0], stiff * g[1]);
  }
}
