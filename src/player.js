// Cannon active ragdoll, hand-attached pull-only web, contact-driven facade/roof gait.
import * as CANNON from '../vendor/cannon-es.js';
import { CFG } from './config.js';
import { makeRagdoll, driveRagdoll, ANATOMY } from './ragdoll.js';
import { steerAccel } from './steer.js';
import { makeStreet, heading, right } from './street.js';
import { ropeStep } from './rope.js';

const HERO = 1, STRUCT = 2, GROUND = 4;

// The plain per-frame copy the game logic and the renderer read (see the contract in game.js).
export const createPlayer = () => ({
  pos: { x: 0, y: CFG.startHeight, z: 0 },
  vel: { x: 0, y: 0, z: CFG.startSpeed },
  anchor: null,
  ropePoints: [], // rope bends, anchor end first (see rope.js); the rope pivots on the last one
  ropeLen: 0, // the free length: pivot to hero
  ropeMin: 0,
  swingPhase: 'none', // 'none' | 'descending' | 'ascending' (past the swing bottom)
  sawDescent: false,
  wall: 0, // wall-running: the face's outward normal along the street's lateral axis (world sign), else 0
  alive: true,
  roof: false,
  mode: 'glide',
  webSide: 'R',
  ragdoll: null,
});

export function createPhysics(p) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -CFG.gravity, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.broadphase.axisIndex = 2; // the course runs along z
  world.defaultContactMaterial.friction = CFG.heroFriction;
  world.defaultContactMaterial.restitution = CFG.heroRestitution;
  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), collisionFilterGroup: GROUND });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // plane normal +z -> +y
  world.addBody(ground);
  world.solver.iterations = 28;
  world.solver.tolerance = 1e-7;
  const suit = new CANNON.Material('suit'), foot = new CANNON.Material('sole');
  const masonry = new CANNON.Material('masonry'); ground.material = masonry;
  // Contacts as stiff as the rope (ropeStiffness): a taut rope must not drag a 0.6 kg hand into a wall.
  const hard = { contactEquationStiffness: CFG.ropeStiffness, contactEquationRelaxation: 3 };
  world.addContactMaterial(new CANNON.ContactMaterial(suit, masonry, { friction: CFG.heroFriction, restitution: .05, ...hard }));
  world.addContactMaterial(new CANNON.ContactMaterial(foot, masonry, { friction: 1.1, restitution: 0, ...hard }));
  const rag = makeRagdoll(world, p, suit, foot), hero = rag.bodies.pelvis;
  const anchor = new CANNON.Body({ mass: 0, collisionFilterGroup: 0, collisionFilterMask: 0 });
  world.addBody(anchor);
  const ph = { world, hero, rag, masonry, anchor, rope: null, reelRate: 0, boxes: new Map(), acc: 0,
    bounced: false, zip: null, wall: null, wallCool: 0, gait: null, webSide: 'R',
    street: makeStreet('z', 0, 1, 0), // the street frame game.js keeps current: wall runs and roof runs go along it
    bound: null }; // (pos, vel) => bool: game.js keeps the hero inside the street corridors (see boundStep)
  for (const body of Object.values(rag.bodies)) body.addEventListener('collide', e => {
    if (Math.abs(e.contact.getImpactVelocityAlongNormal()) > CFG.bounceMinSpeed) ph.bounced = true;
  });
  p.ragdoll = rag.bodies;
  return ph;
}

// Test/setup helper (before play or between runs): carry the whole rig rigidly so the pelvis sits at pos, every body
// moving at vel. Not for use during play (that would be a teleport).
export function placeHero(ph, p, pos, vel = { x: 0, y: 0, z: 0 }) {
  const o = ph.hero.position, d = { x: pos.x - o.x, y: pos.y - o.y, z: pos.z - o.z };
  for (const b of Object.values(ph.rag.bodies)) {
    b.position.set(b.position.x + d.x, b.position.y + d.y, b.position.z + d.z); b.previousPosition.copy(b.position);
    b.velocity.set(vel.x, vel.y, vel.z); b.angularVelocity.setZero();
  }
  copy(ph.hero.position, p.pos); copy(ph.hero.velocity, p.vel);
}

// Add static boxes for new structures, drop the ones the world removed.
export function syncStructures(ph, structures) {
  const live = new Set();
  for (const s of structures) {
    live.add(s.id);
    if (ph.boxes.has(s.id)) continue;
    const { min: a, max: b } = s;
    const body = new CANNON.Body({
      mass: 0, material: ph.masonry, collisionFilterGroup: STRUCT,
      shape: new CANNON.Box(new CANNON.Vec3((b.x - a.x) / 2, (b.y - a.y) / 2, (b.z - a.z) / 2)),
      position: new CANNON.Vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2),
    });
    body.structure = s;
    ph.world.addBody(body);
    ph.boxes.set(s.id, body);
  }
  for (const [id, body] of ph.boxes) if (!live.has(id)) { ph.world.removeBody(body); ph.boxes.delete(id); }
}

const DOWN = { x: 0, y: -1, z: 0 };

// Closest hit of a web from `from` along unit `dir`: {point, attach} (the street and frame beams don't hold), or null.
export function raycast(ph, from, dir, range) {
  const r = new CANNON.RaycastResult();
  ph.world.raycastClosest(
    new CANNON.Vec3(from.x, from.y, from.z),
    new CANNON.Vec3(from.x + dir.x * range, from.y + dir.y * range, from.z + dir.z * range),
    { skipBackfaces: true, collisionFilterMask: STRUCT | GROUND }, r,
  );
  if (!r.hasHit) return null;
  const q = r.hitPointWorld;
  return { point: { x: q.x, y: q.y, z: q.z }, attach: !!r.body.structure?.attach, id: r.body.structure?.id ?? null };
}

// A web on a block-corner tower ('K<col>_<row>_<q>:base', world.js) within turnReach of its edge at the intersection
// ahead is the turning gesture: that rope neither steers back to the street nor reels, so he swings round the corner.
export function isTurnAnchor(ph, point, id) {
  const s = /^K/.test(id ?? '') && ph.boxes.get(id)?.structure;
  if (!s) return false;
  const { axis: f, dir } = ph.street, short = ((dir > 0 ? s.max[f] : s.min[f]) - point[f]) * dir;
  return short >= 0 && short <= CFG.turnReach;
}

// Returns false (miss) for anchors too close to swing on. Replaces a held rope.
// side: the shooting hand ('L' | 'R'); without one, the hand on the anchor's side of the street heading.
// id: the structure it stuck to (optional).
export function attach(ph, p, point, side, id) {
  const rt = right(ph.street), q = ph.hero.position;
  ph.webSide = side === 'L' || side === 'R' ? side : (point.x - q.x) * rt.x + (point.z - q.z) * rt.z < 0 ? 'L' : 'R';
  p.webSide = ph.webSide;
  const hand = ph.rag.bodies['hand' + ph.webSide];
  const len = hand.position.distanceTo(new CANNON.Vec3(point.x, point.y, point.z));
  if (len < CFG.minRopeLen) return false;
  if (ph.rope) ph.world.removeConstraint(ph.rope);
  ph.anchor.position.set(point.x, point.y, point.z);
  ph.rope = new CANNON.DistanceConstraint(hand, ph.anchor, len, CFG.ropeMaxForce);
  const eq = ph.rope.distanceEquation;
  eq.maxForce = 0; // a rope pulls, never pushes: slack when shorter than its length
  eq.setSpookParams(CFG.ropeStiffness, CFG.ropeRelaxation, CFG.physicsStep); // the default assumes a 1/60 s step
  ph.world.addConstraint(ph.rope);
  ph.reelRate = 0;
  ph.zip = null;
  ph.cornerRope = isTurnAnchor(ph, point, id);
  p.anchor = { ...point };
  p.ropePoints = [];
  p.ropeLen = len; // the full length: reeling starts from here, so attaching never yanks the hero
  p.ropeMin = len * CFG.reelMinFactor;
  p.swingPhase = 'descending';
  p.sawDescent = false;
  return true;
}

// Let go: remove the constraint. Nothing touches the velocity. Returns true if a rope was attached.
export function release(ph, p) {
  if (!ph.rope) return false;
  ph.world.removeConstraint(ph.rope);
  ph.rope = null;
  ph.zip = null;
  p.anchor = null;
  p.ropePoints = [];
  p.ropeLen = 0;
  p.swingPhase = 'none';
  return true;
}

const copy = (v, o) => { o.x = v.x; o.y = v.y; o.z = v.z; };

// Zip: on = start pulling toward the anchor (held Space / a hand pull), off = stop. Does nothing without a rope.
// It starts with a snap (zipImpulse toward the anchor), then pulls as a force, so the hero is never moved by position;
// it ends by itself on release or near the anchor.
export function setZip(ph, on) {
  if (!on || !ph.rope) { ph.zip = null; return false; }
  if (!ph.zip) {
    ph.zip = { closing: false };
    const d = ph.anchor.position.vsub(ph.hero.position), dist = d.length();
    const closing = dist > 1e-6 ? d.dot(ph.hero.velocity) / dist : 0;
    const kick = Math.min(CFG.zipImpulse, Math.max(0, CFG.zipMaxSpeed - closing)); // the snap, never past zipMaxSpeed
    if (dist > 1e-6) impulse(ph, d.scale(kick / dist));
  }
  return true;
}

// Zip after a step: arrived = let go before passing the anchor: within zipReleaseDist of it, within half that of
// drawing level with it along z (a high anchor he would pass beneath), or moving away once closing.
// So a zip at an anchor already beside or behind him just lets go.
function zipCheck(ph, p, events) {
  const { hero, anchor } = ph, z = ph.zip;
  const d = anchor.position.vsub(hero.position), dist = d.length();
  const closing = dist > 1e-6 ? d.dot(hero.velocity) / dist : 0;
  if (closing > 1) z.closing = true;
  const ahead = d[ph.street.axis] * ph.street.dir; // anchor still ahead along the street by this much
  if (dist < CFG.zipReleaseDist || ahead < CFG.zipReleaseDist / 2 || (z.closing && closing <= 0)) {
    release(ph, p); // the velocity is untouched: he flies on with all of it
    events.push('released', 'zipped');
  }
}

const comVelocity = (ph) => {
  const v = { x: 0, y: 0, z: 0 }; let m = 0;
  for (const b of Object.values(ph.rag.bodies)) { v.x += b.mass * b.velocity.x; v.y += b.mass * b.velocity.y; v.z += b.mass * b.velocity.z; m += b.mass; }
  v.x /= m; v.y /= m; v.z /= m; return v;
};

// Whole-body impulses preserve a coherent velocity across the joint chain.
function impulse(ph, dv) {
  for (const b of Object.values(ph.rag.bodies)) b.applyImpulse(new CANNON.Vec3(dv.x * b.mass, dv.y * b.mass, dv.z * b.mass));
}

// The side face (facing across the street: lateral axis a) of a tower the pelvis is beside: {s, body, n, x},
// n = outward normal along a (world sign), x = the face's coordinate on a.
function sideFace(ph, pos, reach) {
  const a = ph.street.lat, f = ph.street.axis;
  for (const body of ph.boxes.values()) {
    const s = body.structure;
    if (s.kind !== 'tower' && s.kind !== 'setback') continue;
    if (pos.y < s.min.y + 1.5 || pos.y > s.max.y - 1 || pos[f] < s.min[f] || pos[f] > s.max[f]) continue;
    if (pos[a] <= s.min[a] && s.min[a] - pos[a] < reach) return { s, body, n: -1, x: s.min[a] };
    if (pos[a] >= s.max[a] && pos[a] - s.max[a] < reach) return { s, body, n: 1, x: s.max[a] };
  }
  return null;
}

function clearGait(ph) {
  if (ph.gait) for (const g of Object.values(ph.gait)) if (g.pin) ph.world.removeConstraint(g.pin);
  ph.gait = null;
}

function wallStep(ph, p, events) {
  const h = CFG.physicsStep, root = ph.hero, a = ph.street.lat, f = ph.street.axis, fd = ph.street.dir;
  ph.wallCool = Math.max(0, ph.wallCool - h);
  if (ph.wall) {
    const w = ph.wall; w.sec += h;
    const s = w.s, q = root.position;
    if (w.sec < CFG.wallRunSec && ph.boxes.has(s.id) && q[f] > s.min[f] && q[f] < s.max[f] && q.y > s.min.y + 1 && q.y < s.max.y - .6) return;
    clearGait(ph);
    const J = new CANNON.Vec3(0, CFG.wallJump.up, 0); J[a] = w.n * CFG.wallJump.out; J[f] = fd * CFG.wallJump.fwd;
    impulse(ph, J);
    ph.wall = null; ph.wallCool = CFG.wallRunCooldownSec; p.wall = 0;
    events.push('walljump'); return;
  }
  if (ph.wallCool > 0 || !p.alive) return;
  const face = sideFace(ph, root.position, .8);
  const incoming = comVelocity(ph)[a];
  if (!face || -face.n * incoming < CFG.wallRunMinSpeed) return;
  ph.wall = { ...face, sec: 0, speed: Math.min(2.5, Math.max(1.7, Math.abs(root.velocity[f]))) };
  p.wall = face.n; p.roof = false;
  clearGait(ph);
  events.push('wallrun');
}

// Adhesion is assistance; feet still reach the surface under joint torques and pin only on contact.
function gaitForces(ph, p) {
  const wall = ph.wall, root = ph.hero, h = CFG.physicsStep;
  const a = ph.street.lat, f = ph.street.axis, fd = ph.street.dir, rt = right(ph.street); // street frame
  let surface = wall;
  if (!wall && p.roof) {
    const hit = new CANNON.RaycastResult();
    ph.world.raycastClosest(root.position, root.position.vadd(new CANNON.Vec3(0, -1.25, 0)), { collisionFilterMask: STRUCT }, hit);
    if (hit.hasHit) surface = { body: hit.body, x: hit.hitPointWorld.y, n: 1, sec: ph.rag.time, speed: CFG.roofRunSpeed };
  }
  if (!surface) { clearGait(ph); return; }
  if (!ph.gait) ph.gait = Object.fromEntries(['L', 'R'].map(side => [side, { pin: null, plants: 0, goal: new CANNON.Vec3(), contact: null, cycle: -1 }]));
  const age = wall ? wall.sec : ph.rag.time, period = wall ? .54 : .42;
  for (const [side, g] of Object.entries(ph.gait)) {
    const foot = ph.rag.bodies['foot' + side];
    const phase0 = age / period + (side === 'R' ? .5 : 0), phase = phase0 % 1, cycle = Math.floor(phase0);
    const stance = phase < .6;
    if ((!stance || g.cycle !== cycle) && g.pin) { ph.world.removeConstraint(g.pin); g.pin = null; }
    const sd = side === 'L' ? -1 : 1;
    if (g.pin) {
      g.goal.copy(g.contact);
    } else {
      const swing = clamp((phase - .6) / .4, 0, 1), lift = stance ? 0 : Math.sin(swing * Math.PI) * .22;
      const fwd = stance ? .22 : -.28 + .55 * swing;
      if (wall) { g.goal.set(0, root.position.y - surface.n * sd * .09, 0); g.goal[a] = surface.x + surface.n * (.05 + lift); }
      else g.goal.set(root.position.x + rt.x * sd * .09, surface.x + .05 + lift, root.position.z + rt.z * sd * .09);
      g.goal[f] = root.position[f] + fd * fwd;
      const sole = foot.pointToWorldFrame(new CANNON.Vec3(0, -.045, 0));
      const normalGap = wall ? (sole[a] - surface.x) * surface.n : sole.y - surface.x;
      if (stance && age > .25 && Math.abs(normalGap) < .09 && Math.abs(sole[f] - g.goal[f]) < .38) {
        // Pin the actual contact location: no teleport, no moving anchor while planted.
        const point = sole.clone(); if (wall) point[a] = surface.x; else point.y = surface.x;
        g.contact = point.clone(); if (wall) g.contact[a] += surface.n * .045; else g.contact.y += .045;
        g.pin = new CANNON.PointToPointConstraint(foot, new CANNON.Vec3(0, -.045, 0), surface.body, surface.body.pointToLocalFrame(point), 3500);
        for (const eq of g.pin.equations) eq.setSpookParams(2e7, 4, h);
        ph.world.addConstraint(g.pin); g.plants++;
        g.goal.copy(g.contact);
      }
    }
    g.cycle = cycle;
    // Swing-leg assistance is a bounded muscle endpoint force, not a transform assignment.
    if (!g.pin) {
      const delta = g.goal.vsub(foot.position), relative = foot.velocity.vsub(root.velocity);
      const force = delta.scale(380).vsub(relative.scale(20));
      const l = force.length(); if (l > 160) force.scale(160 / l, force);
      foot.applyForce(force); root.applyForce(force.negate());
    }
  }
  if (wall) {
    const gap = (root.position[a] - wall.x) * wall.n;
    for (const body of Object.values(ph.rag.bodies)) {
      body.force.y += body.mass * (CFG.gravity * (1 - CFG.wallRunGravity) - 5 * body.velocity.y);
      body.force[a] += body.mass * wall.n * (95 * (.78 - gap) - 16 * root.velocity[a] * wall.n);
      body.force[f] += body.mass * fd * clamp((wall.speed - fd * body.velocity[f]) * 10, -110, 18);
    }
  } else {
    const feet = Object.entries(ph.gait).filter(([side, g]) => g.pin || Math.abs(ph.rag.bodies['foot' + side].position.y - surface.x) < .13);
    if (feet.length) {
      const fy = CFG.heroMass * clamp(CFG.gravity + 90 * (surface.x + .96 - root.position.y) - 14 * root.velocity.y, 0, 35);
      const fz = CFG.heroMass * clamp((CFG.roofRunSpeed - fd * root.velocity[f]) * 8, -10, 14) * fd; // along the street
      const F = new CANNON.Vec3(0, fy, 0); F[f] = fz;
      root.applyForce(F);
      for (const [side] of feet) ph.rag.bodies['foot' + side].applyForce(F.scale(-1 / feet.length));
    }
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Swept centres against expanded structure boxes prevent thin extremities crossing a face in one step.
// Forces and impulses do the correction before integration; body positions/orientations are never projected.
// near: the structures within reach this step (see stepPhysics), not the whole city.
function sweepContacts(ph, h, near) {
  for (const b of Object.values(ph.rag.bodies)) {
    const radius = Math.max(b.part.startsWith('foot') ? .065 : .16, Math.min(...ANATOMY.find(a => a.name === b.part).size) * 1.1);
    for (const s of near) {
      let entry = 0, exit = 1, axis = null;
      for (const k of ['x', 'y', 'z']) {
        const d = b.velocity[k] * h, lo = s.min[k] - radius, hi = s.max[k] + radius;
        if (Math.abs(d) < 1e-10) { if (b.position[k] < lo || b.position[k] > hi) { entry = 2; break; } continue; }
        const a = (lo - b.position[k]) / d, z = (hi - b.position[k]) / d;
        const near = Math.min(a, z);
        if (near > entry) { entry = near; axis = k; }
        exit = Math.min(exit, Math.max(a, z));
      }
      if (axis && entry <= exit && entry >= 0 && entry < 1) {
        const old = b.velocity[axis];
        b.applyImpulse(new CANNON.Vec3(axis === 'x' ? -old * (1 - entry) * b.mass : 0,
          axis === 'y' ? -old * (1 - entry) * b.mass : 0, axis === 'z' ? -old * (1 - entry) * b.mass : 0));
        if (Math.abs(old) > CFG.bounceMinSpeed) ph.bounced = true;
      }
    }
  }
}

// The block interiors are out of bounds (game.js: clampToStreets). Instead of moving him, an impulse cancels the
// centre-of-mass velocity into the block and a bounded push carries him back out over the next steps.
function boundStep(ph) {
  const h = CFG.physicsStep, v = comVelocity(ph), q = ph.hero.position;
  const ahead = { x: q.x + v.x * h, y: q.y, z: q.z + v.z * h }, pos = { ...ahead }, vel = { ...v }; // one step ahead
  if (!ph.bound(pos, vel)) return;
  const push = (k) => clamp((pos[k] - ahead[k]) / h * .5, -4, 4);
  impulse(ph, { x: vel.x - v.x + push('x'), y: 0, z: vel.z - v.z + push('z') });
}

// Advance by dt in fixed steps (leftover time carries to the next frame).
// Events: 'bottom', 'bounce', 'dead', 'released' + 'zipped' (a zip reached its anchor), 'wallrun', 'walljump',
// 'snapped' (the rope could not wrap around what cut it and let go).
export function stepPhysics(ph, p, dt) {
  const events = [];
  const h = CFG.physicsStep, { hero } = ph;
  ph.acc += Math.min(dt, CFG.maxDt);
  while (ph.acc >= h - 1e-9) {
    ph.acc -= h;
    const v = hero.velocity;
    for (const b of Object.values(ph.rag.bodies)) {
      const k = CFG.airDrag * b.mass * b.velocity.length();
      b.force.vsub(b.velocity.scale(k), b.force);
    }
    if (p.alive) { wallStep(ph, p, events); gaitForces(ph, p); }
    driveRagdoll(ph, p, h);
    if (ph.zip) {
      const d = ph.anchor.position.vsub(hero.position), dist = d.length();
      if (dist > 1e-6 && d.dot(v) / dist < CFG.zipMaxSpeed) {
        for (const b of Object.values(ph.rag.bodies)) b.force.vadd(d.scale(CFG.zipAccel * b.mass / dist), b.force);
      }
    }
    // body English (steer.js): the same acceleration on every body (force = its mass * a), so the whole rig turns
    // as one and momentum stays physical (no internal joint load from a pelvis-only push).
    // (not on a corner tower's rope: that swing is the turn, and steering would hold him on the old street)
    if (ph.rope && !ph.cornerRope) {
      const a = steerAccel(comVelocity(ph), heading(ph.street));
      for (const b of Object.values(ph.rag.bodies)) { b.force.x += b.mass * a.x; b.force.z += b.mass * a.z; }
    }
    if (ph.rope) {
      let len = ph.rope.distance;
      const d = ph.rope.bodyA.position.distanceTo(ph.anchor.position);
      // the reel spins up under tension (a sudden full-speed reel would jerk the hero), stops when slack
      ph.reelRate = d >= len - .2 ? Math.min(CFG.reelSpeed, ph.reelRate + CFG.reelAccel * h) : Math.max(0, ph.reelRate - CFG.reelAccel * h);
      if (d < len) len = Math.max(CFG.minRopeLen, d); // take up slack (no force: it never moves the hero)
      // reel in under tension (not round a corner tower: the full length carries him past its edge)
      if (len > p.ropeMin && !ph.cornerRope) len = Math.max(p.ropeMin, len - ph.reelRate * h);
      ph.rope.distance = p.ropeLen = len;
    }
    // Fast limbs need smaller collision steps: joint impulses can accelerate a hand after the sweep.
    const maxTravel = Math.max(...Object.values(ph.rag.bodies).map(b => b.velocity.length() * h));
    const steps = Math.max(1, Math.min(8, Math.ceil(maxTravel / .12))), sub = h / steps;
    const loads = Object.values(ph.rag.bodies).map(b => [b, b.force.clone(), b.torque.clone()]);
    const grip = ph.rope?.bodyA.position, P0 = grip && { x: grip.x, y: grip.y, z: grip.z };
    const q = hero.position, reach = 2.5 + 8 * maxTravel; // the rig's size plus several steps of travel
    const near = [];
    for (const { structure: t } of ph.boxes.values()) {
      if (q.x > t.min.x - reach && q.x < t.max.x + reach && q.y > t.min.y - reach && q.y < t.max.y + reach
        && q.z > t.min.z - reach && q.z < t.max.z + reach) near.push(t);
    }
    for (let i = 0; i < steps; i++) {
      if (i) for (const [b, force, torque] of loads) { b.force.copy(force); b.torque.copy(torque); }
      sweepContacts(ph, sub, near);
      ph.world.step(sub);
    }
    if (ph.bound) boundStep(ph);
    if (ph.rope && !ropeStep(ph, p, P0, STRUCT)) { release(ph, p); events.push('snapped'); } // can't bend around it
    if (ph.zip) zipCheck(ph, p, events);
    if (ph.rope) {
      if (v.y <= 0) p.sawDescent = true;
      if (p.swingPhase === 'descending' && p.sawDescent && v.y > 0) { p.swingPhase = 'ascending'; events.push('bottom'); }
    }
    // Only an upward facade/roof contact can start roof locomotion.
    p.roof = p.alive && !ph.wall && !ph.rope && hero.position.y > 1.2 && !!raycast(ph, hero.position, DOWN, 1.12);
    const touchedStreet = Object.values(ph.rag.bodies).some(b => b.position.y < .12);
    if (p.alive && touchedStreet) {
      release(ph, p); clearGait(ph); ph.wall = null; p.wall = 0; p.roof = false;
      p.alive = false; events.push('dead');
    }
  }
  if (ph.bounced) { ph.bounced = false; events.push('bounce'); }
  copy(hero.position, p.pos);
  copy(hero.velocity, p.vel);
  return events;
}
