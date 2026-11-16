// Gameplay physics: the CORE. One dynamic sphere (the forward-swing hero) carries everything that decides the run:
// ropes, reel, steering, wall and roof runs, the slingshot zip, rope wrapping, death. The active ragdoll (rig.js) is a
// follower in its own Cannon world: it reads the core and never pushes back, so the core trajectory is identical
// with or without it (tests/core.test.js).
import * as CANNON from '../vendor/cannon-es.js';
import { CFG } from './config.js';
import { steerAccel } from './steer.js';
import { MOVES } from './moves.js';
import { zipLaunch } from './zip.js';
import { makeStreet, heading, right } from './street.js';
import { ropeStep } from './rope.js';
import { createRig, syncRig, placeRig, stepRig } from './rig.js';

const HERO = 1, STRUCT = 2, GROUND = 4;

// The plain per-frame copy the game logic and the renderer read (see the contract in game.js).
export const createPlayer = () => ({
  pos: { x: 0, y: CFG.startHeight, z: 0 },
  vel: { x: 0, y: 0, z: CFG.startSpeed },
  anchor: null,
  ropePoints: [], // rope bends, anchor end first (see rope.js); the rope pivots on the last one
  ropeLen: 0, // the free length: pivot to hero
  ropeMin: 0,
  ropes: [], // every held rope (one per hand slot): [{slot, anchor, len, tension}]; anchor/ropePoints above = the latest
  swingPhase: 'none', // 'none' | 'descending' | 'ascending' (past the swing bottom)
  sawDescent: false,
  wall: 0, // wall-running: the face's outward normal along the street's lateral axis (world sign), else 0
  alive: true,
  roof: false,
  mode: 'glide',
  webSide: 'R',
  ragdoll: null, // the follower's bodies (rig.js), read-only, null without a rig
  headingYaw: 0,
  climb: 0, // climbing STRAIGHT UP a facade: its outward normal along the street's lateral axis, else 0
  perch: false, // crouched on a roof edge after a vault
  roofIdle: false, // standing still on a roof (no input for roofIdleSec)
  phase: 'play', // the start: 'idle' (on the start roof's edge) | 'dive' (head first off it) | 'play'
});

// rig: false builds the core alone (bots, metrics: fast and deterministic); the game always has the follower.
export function createPhysics(p, { rig = true, seed = 1 } = {}) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -CFG.gravity, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.broadphase.axisIndex = 2;
  world.defaultContactMaterial.friction = CFG.heroFriction;
  world.defaultContactMaterial.restitution = CFG.heroRestitution;
  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), collisionFilterGroup: GROUND });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // plane normal +z -> +y
  world.addBody(ground);
  const hero = new CANNON.Body({
    mass: CFG.heroMass, shape: new CANNON.Sphere(CFG.heroRadius), fixedRotation: true,
    linearDamping: 0, angularDamping: 0, allowSleep: false, // drag is applied explicitly (quadratic)
    collisionFilterGroup: HERO, collisionFilterMask: STRUCT | GROUND,
    position: new CANNON.Vec3(p.pos.x, p.pos.y, p.pos.z), velocity: new CANNON.Vec3(p.vel.x, p.vel.y, p.vel.z),
  });
  world.addBody(hero);
  const anchor = new CANNON.Body({ mass: 0, collisionFilterGroup: 0, collisionFilterMask: 0 }); // rope end point
  world.addBody(anchor);
  const ph = { world, hero, anchor, rope: null, slots: { L: null, R: null }, ropeSeq: 0, boxes: new Map(), acc: 0, bounced: false,
    wall: null, wallCool: 0, webSide: 'R', zipKick: null, zipCooldown: 0, landing: null, cornerRope: false,
    startPhase: 'play', load: 0, prevVel: hero.velocity.clone(), climb: null, perch: null, vault: false, roofSec: 0,
    street: makeStreet('z', 0, 1, 0), // the street frame game.js keeps current: wall runs and roof runs go along it
    bound: null, // (pos, vel) => bool: game.js keeps the hero inside the street corridors (see boundStep)
    // the follower's motion layer (rig.js, docs/motion-hooks.md); gameplay never reads these
    motion: null, targetBlend: null, pendingTrick: null, flight: null, rig: null, rag: null };
  hero.addEventListener('collide', (e) => {
    if (Math.abs(e.contact.getImpactVelocityAlongNormal()) > CFG.bounceMinSpeed) ph.bounced = true;
  });
  if (rig) { ph.rig = createRig(p, seed); ph.rag = ph.rig.rag; p.ragdoll = ph.rag.bodies; }
  return ph;
}

// Setup helper (game start, tests): put the core at pos with vel (the follower comes along, turned by yaw).
// Not for use during play (that would be a teleport).
export function placeHero(ph, p, pos, vel = { x: 0, y: 0, z: 0 }, yaw = 0) {
  ph.hero.position.set(pos.x, pos.y, pos.z); ph.hero.previousPosition.copy(ph.hero.position);
  ph.hero.velocity.set(vel.x, vel.y, vel.z); ph.prevVel.copy(ph.hero.velocity);
  if (ph.rig) placeRig(ph, p, pos, vel, yaw);
  copy(ph.hero.position, p.pos); copy(ph.hero.velocity, p.vel);
}

// Add static boxes for new structures, drop the ones the world removed (in the core world and the follower's).
export function syncStructures(ph, structures) {
  const live = new Set();
  for (const s of structures) {
    live.add(s.id);
    if (ph.boxes.has(s.id)) continue;
    const { min: a, max: b } = s;
    const body = new CANNON.Body({
      mass: 0, collisionFilterGroup: STRUCT,
      shape: new CANNON.Box(new CANNON.Vec3((b.x - a.x) / 2, (b.y - a.y) / 2, (b.z - a.z) / 2)),
      position: new CANNON.Vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2),
    });
    body.structure = s;
    ph.world.addBody(body);
    ph.boxes.set(s.id, body);
  }
  for (const [id, body] of ph.boxes) if (!live.has(id)) { ph.world.removeBody(body); ph.boxes.delete(id); }
  if (ph.rig) syncRig(ph.rig, structures);
}

const DOWN = { x: 0, y: -1, z: 0 };

// Closest hit of a web from `from` along unit `dir`: {point, attach, id} (the street and frame beams don't hold), or null.
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

// Ropes: one per hand slot ('L' | 'R'), each a pull-only DistanceConstraint from the CORE to its own static anchor
// body, with its own reel and its own wrapping (rope.js). Both pull at once: the solver adds their tensions. The most
// recent rope is the 'latest': ph.rope / ph.anchor / ph.webSide / p.anchor / p.ropePoints / p.ropeLen mirror it (the
// rig's grip, the camera and the bot read those); p.ropes lists them all.
const latest = (ph) => [ph.slots.L, ph.slots.R].filter(Boolean).reduce((a, r) => (!a || r.seq > a.seq ? r : a), null);
function syncRopes(ph, p) {
  const r = latest(ph);
  ph.rope = r?.rope ?? null; ph.cornerRope = !!r?.cornerRope;
  if (r) { ph.anchor = r.body; ph.webSide = p.webSide = r.side; }
  p.anchor = r?.anchor ?? null; p.ropePoints = r?.ropePoints ?? []; p.ropeLen = r?.ropeLen ?? 0; p.ropeMin = r?.ropeMin ?? 0;
  p.ropes = ['L', 'R'].filter((k) => ph.slots[k]).map((k) => ({ slot: k, anchor: ph.slots[k].anchor, len: ph.slots[k].ropeLen,
    tension: ropeTension(ph, k), ropePoints: ph.slots[k].ropePoints }));
}
// Newtons the rope pulled with in the last solve (cannon stores lambda / dt; pulling is negative).
export const ropeTension = (ph, slot) => Math.max(0, -(ph.slots[slot]?.rope.distanceEquation.multiplier ?? 0));

// Returns false (miss) for anchors too close to swing on; a miss keeps the held rope. Replaces that slot's rope only.
// side: the shooting hand's slot ('L' | 'R'); without one, the hand on the anchor's side of the street heading.
// id: the structure it stuck to (optional).
export function attach(ph, p, point, side, id) {
  const rt = right(ph.street), q = ph.hero.position;
  const slot = side === 'L' || side === 'R' ? side : (point.x - q.x) * rt.x + (point.z - q.z) * rt.z < 0 ? 'L' : 'R';
  const len = q.distanceTo(new CANNON.Vec3(point.x, point.y, point.z));
  if (len < CFG.minRopeLen) return false;
  dropSlot(ph, slot);
  const body = new CANNON.Body({ mass: 0, collisionFilterGroup: 0, collisionFilterMask: 0, position: new CANNON.Vec3(point.x, point.y, point.z) });
  ph.world.addBody(body);
  const rope = new CANNON.DistanceConstraint(ph.hero, body, len, CFG.ropeMaxForce);
  const eq = rope.distanceEquation;
  eq.maxForce = 0; // a rope pulls, never pushes: slack when shorter than its length
  eq.setSpookParams(CFG.ropeStiffness, CFG.ropeRelaxation, CFG.physicsStep); // the default assumes a 1/60 s step
  ph.world.addConstraint(rope);
  // ropeLen: the full length, so attaching never yanks the hero; reeling starts from here
  ph.slots[slot] = { side: slot, rope, body, anchor: { ...point }, ropePoints: [], ropeLen: len, ropeMin: len * CFG.reelMinFactor,
    reelRate: 0, cornerRope: isTurnAnchor(ph, point, id), seq: ++ph.ropeSeq };
  p.swingPhase = 'descending';
  p.sawDescent = false;
  syncRopes(ph, p);
  return true;
}

function dropSlot(ph, slot) {
  const r = ph.slots[slot];
  if (!r) return false;
  ph.world.removeConstraint(r.rope); ph.world.removeBody(r.body);
  ph.slots[slot] = null;
  return true;
}

// Let go of one slot's rope (slot omitted: every rope). Nothing touches the velocity. Returns true if a rope let go.
export function release(ph, p, slot) {
  const gone = slot === 'L' || slot === 'R' ? dropSlot(ph, slot) : [dropSlot(ph, 'L'), dropSlot(ph, 'R')].some(Boolean);
  if (!gone) return false;
  syncRopes(ph, p);
  if (!ph.rope) p.swingPhase = 'none';
  return true;
}

const copy = (v, o) => { o.x = v.x; o.y = v.y; o.z = v.z; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Motion layer helpers (docs/motion-hooks.md): the follower's pose source. A move's targets are sampled in `basis`.
export function startMove(ph, move, basis) {
  ph.motion = move ? { move, sec: -Number.EPSILON, basis: basis.clone() } : null;
  ph.targetBlend = ph.rag ? { sec: 0, from: Object.fromEntries(Object.entries(ph.rag.targets).map(([n, q]) => [n, q.clone()])) } : null;
}
// Yaw basis of his travel (or of headingYaw when nearly still).
export function travelBasis(p) {
  const speed = Math.hypot(p.vel.x, p.vel.z);
  return new CANNON.Quaternion().setFromEuler(0, speed > .1 ? Math.atan2(p.vel.x, p.vel.z) : (p.headingYaw || 0), 0);
}
// Street airtime of his soles (the core is at the pelvis, soles soleDrop below): a lower bound (drag slows the fall).
export function airtime(ph, p) {
  const footY = ph.hero.position.y - CFG.soleDrop, vy = Math.min(0, p.vel.y);
  return (vy + Math.sqrt(vy * vy + 2 * CFG.gravity * Math.max(0, footY))) / CFG.gravity;
}

// Zip = the slingshot: let go now and launch along the heading, tilted toward the rope (zip.js). The delta-v goes
// into the core over zipLaunchSteps physics steps; the rope is gone the same frame. Cooldown.
export function launchZip(ph, p) {
  if (!ph.rope || ph.zipCooldown > 0 || !p.alive || ph.zipKick) return false;
  const v = ph.hero.velocity, basis = travelBasis(p);
  const facing = basis.vmult(new CANNON.Vec3(0, 0, 1));
  const head = Math.hypot(v.x, v.z) > .1 ? { x: v.x, y: 0, z: v.z } : facing;
  // two ropes: launch along the sum of the rope unit vectors (each toward its own pivot)
  const rd = [ph.slots.L, ph.slots.R].filter(Boolean).reduce((sum, r) => {
    const u = r.body.position.vsub(ph.hero.position); u.normalize(); return sum.vadd(u);
  }, new CANNON.Vec3());
  const { dv } = zipLaunch({ x: v.x, y: v.y, z: v.z }, head, { x: rd.x, y: rd.y, z: rd.z }, CFG);
  ph.zipFrom = { x: ph.anchor.position.x, y: ph.anchor.position.y, z: ph.anchor.position.z, sec: 0, rise: ph.anchor.position.y - ph.hero.position.y }; // (a climb cue)
  release(ph, p);
  ph.pendingTrick = null;
  ph.zipCooldown = CFG.zipCooldownSec;
  ph.zipKick = { dv, remaining: CFG.zipLaunchSteps };
  startMove(ph, MOVES.zipYank, basis);
  return true;
}

// The rooftop start: Space / open palm on the title. A head-first DIVE off the start roof's edge, out over the street
// (the follower spreads and sweeps its arms back, streamlined). He is in play on his first web press, or when the
// street comes close (the prelanding), whichever is first.
export function startDive(ph, p) {
  if (ph.startPhase !== 'idle') return false;
  ph.startPhase = p.phase = 'dive'; p.roof = false; p.roofIdle = false;
  const h = heading(ph.street);
  ph.hero.velocity.vadd(new CANNON.Vec3(h.x * CFG.dive.out, CFG.dive.up, h.z * CFG.dive.out), ph.hero.velocity);
  startMove(ph, MOVES.roofDive, travelBasis(p));
  return true;
}

// The side face (facing across the street: lateral axis a) of a tower the core is beside: {s, n, x},
// n = outward normal along a (world sign), x = the face's coordinate on a.
function sideFace(ph, pos, skin) {
  const a = ph.street.lat, f = ph.street.axis, r = CFG.heroRadius + skin;
  for (const { structure: s } of ph.boxes.values()) {
    if (s.kind !== 'tower' && s.kind !== 'setback') continue;
    if (pos.y < s.min.y || pos.y > s.max.y || pos[f] < s.min[f] || pos[f] > s.max[f]) continue;
    if (pos[a] <= s.min[a] && s.min[a] - pos[a] < r) return { s, n: -1, x: s.min[a] };
    if (pos[a] >= s.max[a] && pos[a] - s.max[a] < r) return { s, n: 1, x: s.max[a] };
  }
  return null;
}

// Wall run after a step (the forward-swing sphere's, on the current street's axes). v0 = the velocity before the
// step (the hit has already bounced it).
function wallStep(ph, p, v0, events) {
  const { hero } = ph, v = hero.velocity, h = CFG.physicsStep, a = ph.street.lat, f = ph.street.axis;
  ph.wallCool = Math.max(0, ph.wallCool - h);
  const w = ph.wall;
  if (w) {
    w.sec += h;
    const still = sideFace(ph, hero.position, CFG.wallRunSkin);
    if (w.sec < CFG.wallRunSec && still && still.n === w.n) {
      v[a] = 0; // held on the face: no bounce, no drifting off
      // the run speed replaces drag; the face's friction (mu * g) bleeds a little of it
      w.fwd -= Math.sign(w.fwd) * Math.min(Math.abs(w.fwd), CFG.heroFriction * CFG.gravity * h);
      if (Math.abs(v[f]) < Math.abs(w.fwd)) v[f] = w.fwd;
      return;
    }
    const J = CFG.wallJump, fd = Math.sign(w.fwd) || ph.street.dir;
    v[a] += w.n * J.out; v.y = Math.max(v.y, 0) + J.up; v[f] += fd * J.fwd;
    ph.wall = null; ph.wallCool = CFG.wallRunCooldownSec; p.wall = 0;
    events.push('walljump');
    return;
  }
  if (ph.wallCool > 0 || !p.alive) return;
  const face = sideFace(ph, hero.position, CFG.wallRunSkin);
  if (!face || -face.n * v0[a] < CFG.wallRunMinSpeed) return; // not moving into that face fast enough
  // moving mostly UP into it (or zipping toward a web high on this same face): straight up the facade
  const C = CFG.climb, q = ph.zipFrom;
  const webUp = q && q.sec < 1.5 && q.rise > C.zipRise && Math.abs(q[a] - face.x) < 1 && q.y > hero.position.y + 5;
  if ((v0.y > C.minUp && v0.y >= C.upShare * Math.abs(v0[f])) || webUp) {
    if (release(ph, p)) events.push('released');
    ph.climb = { ...face, sec: 0 }; p.climb = face.n; p.roof = false;
    v[a] = 0; v[f] *= .3; v.y = Math.max(v.y, C.speed);
    events.push('wallclimb');
    return;
  }
  ph.wall = { ...face, sec: 0, fwd: v0[f] };
  v[a] = 0;
  v.y = Math.max(v.y, -CFG.wallRunMaxSink);
  v[f] = v0[f];
  p.wall = face.n; p.roof = false;
  events.push('wallrun');
}

// Climbing straight up a facade (the core: a steady climb; the follower strides up the glass). At the roof edge he
// vaults over it and perches; short of it after climb.sec he kicks off backward.
function climbStep(ph, p, events) {
  const c = ph.climb, v = ph.hero.velocity, h = CFG.physicsStep, a = ph.street.lat, f = ph.street.axis, C = CFG.climb;
  c.sec += h;
  if (ph.hero.position.y >= c.s.max.y - C.vaultBelow) { // the ledge: up and over, onto the roof
    v.y = C.vaultUp; v[a] = 0; v[f] = 0;
    ph.vault = { n: c.n, top: c.s.max.y, sec: 0 }; ph.climb = null; p.climb = 0; events.push('vault');
    return;
  }
  if (c.sec >= C.sec || !ph.boxes.has(c.s.id)) { // not at the top: kick off backward, away from the face
    v[a] = c.n * CFG.wallJump.out; v.y = C.kickUp; v[f] = 0;
    ph.climb = null; p.climb = 0; ph.wallCool = CFG.wallRunCooldownSec; events.push('walljump');
    return;
  }
  v[a] = -c.n * .5; v.y = C.speed; v[f] *= Math.exp(-6 * h); // on the glass, climbing
}

// The vault: straight up past the ledge, then just over it, landing a step inside the edge (the perch).
function vaultStep(ph) {
  const w = ph.vault, v = ph.hero.velocity, a = ph.street.lat, C = CFG.climb;
  if ((w.sec += CFG.physicsStep) > 1.5) { ph.vault = null; return; }
  if (ph.hero.position.y < w.top + CFG.heroRadius + .05) { v.y = Math.max(v.y, C.vaultUp); v[a] = 0; }
  else { v[a] = -w.n * C.vaultIn; v.y = Math.min(v.y, 0); }
}

// The block interiors are out of bounds (game.js: clampToStreets). Instead of moving him, the velocity into the
// block is cancelled and a bounded push carries him back out over the next steps.
function boundStep(ph) {
  const h = CFG.physicsStep, v = ph.hero.velocity, q = ph.hero.position;
  const ahead = { x: q.x + v.x * h, y: q.y, z: q.z + v.z * h }, pos = { ...ahead }, vel = { x: v.x, y: v.y, z: v.z };
  if (!ph.bound(pos, vel)) return;
  const push = (k) => clamp((pos[k] - ahead[k]) / h * .5, -4, 4);
  v.x = vel.x + push('x'); v.z = vel.z + push('z');
}

// Advance by dt in fixed steps (leftover time carries to the next frame).
// Events: 'bottom', 'bounce', 'dead' + 'landingImpact' (street contact: the hero landing starts), 'wallrun',
// 'walljump', 'snapped' (the rope could not wrap around what cut it and let go).
export function stepPhysics(ph, p, dt) {
  const events = [];
  const h = CFG.physicsStep, { hero } = ph;
  ph.acc += Math.min(dt, CFG.maxDt);
  while (ph.acc >= h - 1e-9) {
    ph.acc -= h;
    if (p.alive) coreStep(ph, p, events);
    else { if (ph.landing) ph.landing.sec += h; landedStep(ph); }
    copy(hero.position, p.pos); copy(hero.velocity, p.vel);
    if (ph.rig) stepRig(ph, p, h);
    ph.prevVel.copy(hero.velocity);
  }
  if (ph.bounced) { ph.bounced = false; events.push('bounce'); }
  copy(hero.position, p.pos);
  copy(hero.velocity, p.vel);
  return events;
}

// After the landing the core slides to rest on the street (friction and the drag of a crouch).
function landedStep(ph) {
  const v = ph.hero.velocity, k = Math.exp(-6 * CFG.physicsStep);
  v.x *= k; v.z *= k; v.y = Math.min(v.y, 0); // no bounce
  ph.world.step(CFG.physicsStep);
}

function coreStep(ph, p, events) {
  const h = CFG.physicsStep, { hero } = ph, v = hero.velocity;
  const idle = ph.startPhase === 'idle';
  const k = CFG.airDrag * CFG.heroMass * v.length();
  hero.force.x -= k * v.x; hero.force.y -= k * v.y; hero.force.z -= k * v.z; // quadratic drag (cleared by every step)
  const v0 = { x: v.x, y: v.y, z: v.z };
  if (ph.startPhase === 'dive' && v.y < 0 && airtime(ph, p) < CFG.moves.landingLeadSec) ph.startPhase = p.phase = 'play';
  if (ph.climb) hero.force.y += CFG.heroMass * CFG.gravity; // the climb carries his weight
  if (ph.wall) hero.force.y += CFG.heroMass * CFG.gravity * (1 - CFG.wallRunGravity); // barely sinks on the wall
  ph.zipCooldown = Math.max(0, ph.zipCooldown - h);
  if (ph.zipFrom) ph.zipFrom.sec += h;
  if (ph.zipKick) { // the slingshot's delta-v, split over zipLaunchSteps steps
    const z = ph.zipKick, n = CFG.zipLaunchSteps;
    v.x += z.dv.x / n; v.y += z.dv.y / n; v.z += z.dv.z / n;
    if (--z.remaining === 0) ph.zipKick = null;
  }
  // body English (steer.js) while on the rope (not on a corner tower's rope: that swing is the turn)
  if (ph.rope && !ph.cornerRope) {
    const a = steerAccel(v, heading(ph.street));
    hero.force.x += CFG.heroMass * a.x; hero.force.z += CFG.heroMass * a.z;
  }
  for (const r of [ph.slots.L, ph.slots.R]) {
    if (!r) continue;
    let len = r.rope.distance;
    const d = hero.position.distanceTo(r.body.position);
    // the reel spins up under tension (a sudden full-speed reel would jerk the hero), stops when slack
    r.reelRate = d >= len - 1e-3 ? Math.min(CFG.reelSpeed, r.reelRate + CFG.reelAccel * h) : 0;
    if (d < len) len = Math.max(CFG.minRopeLen, d); // take up slack (no force: it never moves the hero)
    // reel in under tension (not round a corner tower: the full length carries him past its edge)
    if (len > r.ropeMin && !r.cornerRope && !ph.wall) len = Math.max(r.ropeMin, len - r.reelRate * h);
    r.rope.distance = r.ropeLen = len;
  }
  const P0 = { x: hero.position.x, y: hero.position.y, z: hero.position.z };
  ph.world.step(h);
  if (ph.climb) climbStep(ph, p, events);
  else if (ph.vault && !p.roof) vaultStep(ph);
  else wallStep(ph, p, v0, events);
  if (ph.bound && !idle) boundStep(ph);
  for (const k of ['L', 'R']) { // each rope wraps on its own (rope.js reads a rope through these two views)
    const r = ph.slots[k];
    if (r && !ropeStep({ rope: r.rope, anchor: r.body, boxes: ph.boxes, hero: ph.hero, world: ph.world }, r, P0, STRUCT)) {
      release(ph, p, k); events.push('snapped'); // can't bend around it
    }
  }
  syncRopes(ph, p);
  // The rope's tension (for the follower's strain pose): T = M (|v|^2 - (v.u)^2) / L + M g (-u_y), u = pivot -> hero.
  let tension = 0;
  if (ph.rope) {
    const r = hero.position.vsub(ph.anchor.position), L = r.length();
    if (L > 1e-6 && L >= ph.rope.distance - .05) {
      const u = r.scale(1 / L), vu = v.dot(u);
      tension = Math.max(0, CFG.heroMass * ((v.lengthSquared() - vu * vu) / L - CFG.gravity * u.y));
    }
    if (v.y <= 0) p.sawDescent = true;
    if (p.swingPhase === 'descending' && p.sawDescent && v.y > 0) { p.swingPhase = 'ascending'; events.push('bottom'); }
  }
  ph.load += (Math.min(1, tension / CFG.moves.strainForce) - ph.load) * Math.min(1, h / .1);
  // standing on a roof with no rope: run along the street so a landing never leaves the hero stuck
  p.roof = !idle && ph.startPhase !== 'dive' && !ph.wall && !ph.climb && !ph.rope && hero.position.y > CFG.heroRadius + 1
    && !!raycast(ph, hero.position, DOWN, CFG.heroRadius + .15);
  if (p.roof && ph.vault) { ph.vault = false; ph.perch = { sec: 0 }; } // over the ledge: a crouched perch on the edge
  if (!p.roof) { ph.perch = null; ph.roofSec = 0; }
  p.perch = !!ph.perch; p.roofIdle = false;
  if (p.roof) {
    const f = ph.street.axis, fd = ph.street.dir;
    ph.roofSec += h;
    if (ph.perch) { // crouched on the edge a moment, then he runs on
      v.x = v.z = 0;
      if ((ph.perch.sec += h) >= CFG.climb.perchSec) { ph.perch = null; ph.roofSec = 0; }
    } else if (ph.roofSec >= CFG.roofIdleSec) { // no input for a while: he slows and stands, looking out
      v.x *= Math.exp(-5 * h); v.z *= Math.exp(-5 * h); p.roofIdle = true;
    } else if (v[f] * fd < CFG.roofRunSpeed) v[f] = fd * CFG.roofRunSpeed;
  }
  if (idle) { v.x *= .9; v.z *= .9; } // standing at his spot on the start roof's edge
  if (hero.position.y <= CFG.heroRadius + .05 + CFG.landingGap) { // his soles reach the street: the hero landing
    release(ph, p);
    ph.wall = null; p.wall = 0; p.roof = false; p.alive = false; ph.climb = null; p.climb = 0; ph.perch = null; p.perch = false; ph.zipKick = null; ph.pendingTrick = null;
    ph.landing = { sec: 0, at: { x: hero.position.x, y: 0, z: hero.position.z }, speed: v.length() };
    v.y = 0; // the legs take the fall (the core then settles onto the street and slides to rest)
    startMove(ph, MOVES.landing, travelBasis(p));
    events.push('dead', 'landingImpact');
  }
}
