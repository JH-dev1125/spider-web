import * as C from '../../vendor/cannon-es.js';

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
      collisionFilterGroup: 1, collisionFilterMask: 2 | 4, allowSleep: false });
    // Boxes give reliable narrow-phase contacts at high speed; the skin rounds their silhouette.
    b.addShape(new C.Box(V(a.size)));
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
      for (const eq of joint.equations) eq.setSpookParams(1e8, 4, 1 / 120);
      world.addConstraint(joint); joints.push({ a, parent, body: b, joint });
    }
  }
  return { bodies, joints, targets: Object.fromEntries(ANATOMY.map(a => [a.name, new C.Quaternion()])), time: 0 };
}

// Quaternion error -> critically damped, torque-limited PD muscle. No body transforms are assigned.
function muscle(body, target, parent, kp, kd, limit) {
  const inv = body.quaternion.conjugate(), error = target.mult(inv);
  const sign = error.w < 0 ? -1 : 1;
  const w = body.angularVelocity.vsub(parent?.angularVelocity || C.Vec3.ZERO);
  const torque = new C.Vec3(2 * sign * error.x * kp - kd * w.x,
    2 * sign * error.y * kp - kd * w.y, 2 * sign * error.z * kp - kd * w.z);
  const len = torque.length(); if (len > limit) torque.scale(limit / len, torque);
  body.torque.vadd(torque, body.torque);
  if (parent) parent.torque.vsub(torque, parent.torque);
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

export function driveRagdoll(ph, p, h) {
  const r = ph.rag, b = r.bodies, t = r.targets;
  r.time += h;
  r.modeTime = r.mode === p.mode ? (r.modeTime || 0) + h : 0; r.mode = p.mode;
  if (!p.alive) return; // death keeps anatomical limits, removes every muscle
  const basis = new C.Quaternion();
  if (ph.wall) basis.setFromAxisAngle(new C.Vec3(0, 0, 1), -ph.wall.n * Math.PI / 2);
  else if (!p.roof && p.anchor) {
    const d = ph.anchor.position.vsub(b.pelvis.position); d.normalize();
    const up = new C.Vec3(d.x * .4, Math.max(.6, d.y), d.z * .35); up.normalize(); basis.setFromVectors(UP, up);
  }
  if (!ph.wall && !p.roof && !p.anchor) {
    if (p.mode === 'roll') basis.setFromAxisAngle(new C.Vec3(0, 0, 1), r.modeTime * Math.PI * 2 / .6);
    else if (p.mode === 'glide') basis.setFromEuler(.35, 0, 0);
  }
  for (const a of ANATOMY) t[a.name].copy(basis);
  for (const side of ['L', 'R']) {
    const sd = side === 'L' ? -1 : 1;
    const upper = t['upperArm' + side], lower = t['forearm' + side];
    const isWeb = ph.rope && side === ph.webSide;
    if (isWeb) {
      const sh = b.chest.pointToWorldFrame(new C.Vec3(sd * .24, .18, 0));
      limbTarget(upper, sh, ph.anchor.position); lower.copy(upper); t['hand' + side].copy(upper);
    } else {
      const q = new C.Quaternion();
      q.setFromEuler(-.25, 0, sd * (ph.wall || p.roof ? .25 : 1.05)); basis.mult(q, upper);
      q.setFromEuler(-.35, 0, 0); upper.mult(q, lower); t['hand' + side].copy(lower);
    }
    if (ph.wall || p.roof) {
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
  // Balance assistance supplies an upright reference; joints still react against one another.
  muscle(b.pelvis, basis, null, ph.wall || p.roof ? 1600 : 180, ph.wall || p.roof ? 110 : 25, ph.wall || p.roof ? 650 : 100);
  for (const j of r.joints) {
    const desired = t[j.a.parent].conjugate().mult(t[j.a.name]);
    const target = j.parent.quaternion.mult(desired);
    const leg = /thigh|shin/.test(j.a.name), trunk = j.a.name === 'chest';
    const kp = trunk ? 380 : leg ? 250 : 65, kd = trunk ? 25 : leg ? 18 : 4;
    muscle(j.body, target, j.parent, kp, kd, trunk ? 200 : leg ? 130 : 65);
  }
}
