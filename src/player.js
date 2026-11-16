// Hero physics on cannon-es: a dynamic sphere, static boxes for every structure, the street as a plane,
// and up to two webs (slot 'L' / 'R', see ropes.js): pull-only constraints that stay taut and reel down smoothly.
// Releasing just removes a constraint, so the hero keeps exactly the velocity the swing gave it.
import * as CANNON from '../vendor/cannon-es.js';
import { CFG } from './config.js';
import { createRopes } from './ropes.js';

const HERO = 1, STRUCT = 2, GROUND = 4;

// The plain per-frame copy the game logic and the renderer read (see the contract in game.js).
export const createPlayer = () => ({
  pos: { x: 0, y: CFG.startHeight, z: 0 },
  vel: { x: 0, y: 0, z: CFG.startSpeed },
  anchor: null, // the most recent held rope's anchor (kept for single-rope readers)
  ropes: [], // every held rope: [{slot, anchor, len, tension}]
  ropeLen: 0,
  ropeMin: 0,
  swingPhase: 'none', // 'none' | 'descending' | 'ascending' (past the swing bottom)
  sawDescent: false,
  wall: 0, // wall-running: the face's outward normal x (-1 = wall on the right, +1 = on the left), else 0
  alive: true,
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
  const hero = new CANNON.Body({
    mass: CFG.heroMass, shape: new CANNON.Sphere(CFG.heroRadius), fixedRotation: true,
    linearDamping: 0, angularDamping: 0, allowSleep: false, // drag is applied explicitly (quadratic)
    collisionFilterGroup: HERO, collisionFilterMask: STRUCT | GROUND,
    position: new CANNON.Vec3(p.pos.x, p.pos.y, p.pos.z), velocity: new CANNON.Vec3(p.vel.x, p.vel.y, p.vel.z),
  });
  world.addBody(hero);
  const ph = { world, hero, ropes: createRopes(world), boxes: new Map(), acc: 0, bounced: false, zip: null, wall: null, wallCool: 0 };
  hero.addEventListener('collide', (e) => {
    if (Math.abs(e.contact.getImpactVelocityAlongNormal()) > CFG.bounceMinSpeed) ph.bounced = true;
  });
  return ph;
}

// Add static boxes for new structures, drop the ones the world removed.
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
  return { point: { x: q.x, y: q.y, z: q.z }, attach: !!r.body.structure?.attach };
}

// Copy the held ropes into the view: p.ropes, and p.anchor / ropeLen / ropeMin from the most recent one.
function syncRopes(ph, p) {
  const r = ph.ropes.latest();
  p.ropes = ph.ropes.view();
  p.anchor = r ? r.at : null;
  p.ropeLen = r ? r.len : 0;
  p.ropeMin = r ? r.min : 0;
  if (!r) p.swingPhase = 'none';
}

// Attach slot's rope ('L' / 'R'). Returns false (miss) for anchors too close to swing on. Replaces that slot's rope only.
export function attach(ph, p, point, slot = 'R') {
  if (!ph.ropes.attach(slot, point, ph.hero)) return false;
  ph.zip = null;
  p.swingPhase = 'descending';
  p.sawDescent = false;
  syncRopes(ph, p);
  return true;
}

// Let go of one slot (every rope when slot is omitted). Nothing touches the velocity. Returns true if a rope let go.
export function release(ph, p, slot) {
  if (!ph.ropes.release(slot)) return false;
  if (!ph.ropes.active().length) ph.zip = null;
  syncRopes(ph, p);
  return true;
}

const copy = (v, o) => { o.x = v.x; o.y = v.y; o.z = v.z; };

// Zip direction: the sum of the unit vectors toward every held anchor, normalised (one rope = toward its anchor),
// plus the nearest anchor's distance and the farthest anchor's lead along z for the arrival check. null = no pull.
function zipDir(ph) {
  const u = new CANNON.Vec3();
  let near = Infinity, ahead = -Infinity;
  for (const r of ph.ropes.active()) {
    const d = r.anchor.position.vsub(ph.hero.position), dist = d.length();
    near = Math.min(near, dist); ahead = Math.max(ahead, d.z);
    if (dist > 1e-6) u.vadd(d.scale(1 / dist), u);
  }
  const n = u.length();
  return n > 1e-6 ? { u: u.scale(1 / n), near, ahead } : null;
}

// Zip: on = start pulling along the ropes (held Space / a hand pull), off = stop. Does nothing without a rope.
// It starts with a snap (zipImpulse along zipDir), then pulls as a force, so the hero is never moved by position;
// it ends by itself on release or near the anchor.
export function setZip(ph, on) {
  if (!on || !ph.ropes.active().length) { ph.zip = null; return false; }
  if (!ph.zip) {
    ph.zip = { closing: false };
    const z = zipDir(ph);
    const closing = z ? z.u.dot(ph.hero.velocity) : 0;
    const kick = Math.min(CFG.zipImpulse, Math.max(0, CFG.zipMaxSpeed - closing)); // the snap, never past zipMaxSpeed
    if (z) ph.hero.velocity.vadd(z.u.scale(kick), ph.hero.velocity);
  }
  return true;
}

// Zip after a step: arrived = let go of every rope before passing an anchor: within zipReleaseDist of the nearest,
// within half that of drawing level with every anchor along z (high anchors he would pass beneath), or moving away
// once closing. So a zip at anchors already beside or behind him just lets go.
function zipCheck(ph, p, events) {
  const z = ph.zip, d = zipDir(ph);
  const closing = d ? d.u.dot(ph.hero.velocity) : 0;
  if (closing > 1) z.closing = true;
  if (!d || d.near < CFG.zipReleaseDist || d.ahead < CFG.zipReleaseDist / 2 || (z.closing && closing <= 0)) {
    release(ph, p); // the velocity is untouched: he flies on with all of it
    events.push('released', 'zipped');
  }
}

// Side faces (x-facing) of every structure box the hero's centre is beside: [{s, n, x}], n = outward normal x.
function sideFace(ph, pos, skin) {
  const r = CFG.heroRadius + skin;
  for (const { structure: s } of ph.boxes.values()) {
    if (pos.y < s.min.y || pos.y > s.max.y || pos.z < s.min.z || pos.z > s.max.z) continue;
    if (pos.x <= s.min.x && s.min.x - pos.x < r) return { s, n: -1, x: s.min.x };
    if (pos.x >= s.max.x && pos.x - s.max.x < r) return { s, n: 1, x: s.max.x };
  }
  return null;
}

// Wall run after a step. v0 = the velocity before the step (the hit has already bounced it).
function wallStep(ph, p, v0, events) {
  const { hero } = ph, v = hero.velocity, h = CFG.physicsStep;
  ph.wallCool = Math.max(0, ph.wallCool - h);
  const w = ph.wall;
  if (w) {
    w.sec += h;
    const still = sideFace(ph, hero.position, CFG.wallRunSkin);
    if (w.sec < CFG.wallRunSec && still && still.n === w.n) {
      v.x = 0; // held on the face: no bounce, no drifting off
      // the run speed replaces drag; the face's friction (mu * g) bleeds a little of it
      w.fwd -= Math.sign(w.fwd) * Math.min(Math.abs(w.fwd), CFG.heroFriction * CFG.gravity * h);
      if (Math.abs(v.z) < Math.abs(w.fwd)) v.z = w.fwd;
      return;
    }
    const J = CFG.wallJump, f = Math.sign(w.fwd) || 1;
    v.x += w.n * J.out; v.y = Math.max(v.y, 0) + J.up; v.z += f * J.fwd;
    ph.wall = null; ph.wallCool = CFG.wallRunCooldownSec; p.wall = 0;
    events.push('walljump');
    return;
  }
  if (ph.wallCool > 0) return;
  const f = sideFace(ph, hero.position, CFG.wallRunSkin);
  if (!f || -f.n * v0.x < CFG.wallRunMinSpeed) return; // not moving into that face fast enough
  ph.wall = { ...f, sec: 0, fwd: v0.z };
  v.x = 0;
  v.y = Math.max(v.y, -CFG.wallRunMaxSink);
  v.z = v0.z;
  p.wall = f.n;
  events.push('wallrun');
}

// Advance by dt in fixed steps (leftover time carries to the next frame).
// Events: 'bottom', 'bounce', 'dead', 'released' + 'zipped' (a zip reached its anchor), 'wallrun', 'walljump'.
export function stepPhysics(ph, p, dt) {
  const events = [];
  if (!p.alive) return events;
  const h = CFG.physicsStep, { hero } = ph;
  ph.acc += Math.min(dt, CFG.maxDt);
  while (ph.acc >= h - 1e-9) {
    ph.acc -= h;
    const v = hero.velocity, k = CFG.airDrag * CFG.heroMass * v.length();
    hero.force.x -= k * v.x; hero.force.y -= k * v.y; hero.force.z -= k * v.z; // cleared by every step
    const v0 = { x: v.x, y: v.y, z: v.z };
    if (ph.wall) hero.force.y += CFG.heroMass * CFG.gravity * (1 - CFG.wallRunGravity); // barely sinks on the wall
    if (ph.zip) {
      const z = zipDir(ph);
      if (z && z.u.dot(v) < CFG.zipMaxSpeed) hero.force.vadd(z.u.scale(CFG.zipAccel * CFG.heroMass), hero.force);
    }
    ph.ropes.stepReel(h); // per rope: spins up under tension (a sudden full-speed reel would jerk), stops when slack
    ph.world.step(h);
    if (ph.zip) zipCheck(ph, p, events);
    wallStep(ph, p, v0, events);
    const roped = ph.ropes.active().length > 0;
    if (roped) {
      if (v.y <= 0) p.sawDescent = true;
      if (p.swingPhase === 'descending' && p.sawDescent && v.y > 0) { p.swingPhase = 'ascending'; events.push('bottom'); }
    }
    // standing on a roof with no rope: run forward so a landing never leaves the hero stuck
    p.roof = !roped && hero.position.y > 1 && !!raycast(ph, hero.position, DOWN, CFG.heroRadius + 0.15);
    if (p.roof) v.z = Math.max(v.z, CFG.roofRunSpeed);
    if (hero.position.y <= CFG.heroRadius + 0.05) { // touching the street
      release(ph, p);
      ph.wall = null; p.wall = 0;
      hero.velocity.setZero();
      p.alive = false;
      events.push('dead');
      break;
    }
  }
  if (ph.bounced) { ph.bounced = false; events.push('bounce'); }
  syncRopes(ph, p);
  copy(hero.position, p.pos);
  copy(hero.velocity, p.vel);
  return events;
}
