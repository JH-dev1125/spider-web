// Hero physics on cannon-es: a dynamic sphere, static boxes for every structure, the street as a plane,
// and the web as a pull-only DistanceConstraint that stays taut (slack is taken up) and is reeled down smoothly.
// Releasing just removes the constraint, so the hero keeps exactly the velocity the swing gave it.
import * as CANNON from '../vendor/cannon-es.js';
import { CFG } from './config.js';

const HERO = 1, STRUCT = 2, GROUND = 4;

// The plain per-frame copy the game logic and the renderer read (see the contract in game.js).
export const createPlayer = () => ({
  pos: { x: 0, y: CFG.startHeight, z: 0 },
  vel: { x: 0, y: 0, z: CFG.startSpeed },
  anchor: null,
  ropeLen: 0,
  ropeMin: 0,
  swingPhase: 'none', // 'none' | 'descending' | 'ascending' (past the swing bottom)
  sawDescent: false,
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
  const anchor = new CANNON.Body({ mass: 0, collisionFilterGroup: 0, collisionFilterMask: 0 }); // rope end point
  world.addBody(anchor);
  const ph = { world, hero, anchor, rope: null, reelRate: 0, boxes: new Map(), acc: 0, bounced: false };
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

// Returns false (miss) for anchors too close to swing on. Replaces a held rope.
export function attach(ph, p, point) {
  const len = ph.hero.position.distanceTo(new CANNON.Vec3(point.x, point.y, point.z));
  if (len < CFG.minRopeLen) return false;
  if (ph.rope) ph.world.removeConstraint(ph.rope);
  ph.anchor.position.set(point.x, point.y, point.z);
  ph.rope = new CANNON.DistanceConstraint(ph.hero, ph.anchor, len, CFG.ropeMaxForce);
  const eq = ph.rope.distanceEquation;
  eq.maxForce = 0; // a rope pulls, never pushes: slack when shorter than its length
  eq.setSpookParams(CFG.ropeStiffness, CFG.ropeRelaxation, CFG.physicsStep); // the default assumes a 1/60 s step
  ph.world.addConstraint(ph.rope);
  ph.reelRate = 0;
  p.anchor = { ...point };
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
  p.anchor = null;
  p.ropeLen = 0;
  p.swingPhase = 'none';
  return true;
}

const copy = (v, o) => { o.x = v.x; o.y = v.y; o.z = v.z; };

// Advance by dt in fixed steps (leftover time carries to the next frame). Events: 'bottom', 'bounce', 'dead'.
export function stepPhysics(ph, p, dt) {
  const events = [];
  if (!p.alive) return events;
  const h = CFG.physicsStep, { hero } = ph;
  ph.acc += Math.min(dt, CFG.maxDt);
  while (ph.acc >= h - 1e-9) {
    ph.acc -= h;
    const v = hero.velocity, k = CFG.airDrag * CFG.heroMass * v.length();
    hero.force.x -= k * v.x; hero.force.y -= k * v.y; hero.force.z -= k * v.z; // cleared by every step
    if (ph.rope) {
      let len = ph.rope.distance;
      const d = hero.position.distanceTo(ph.anchor.position);
      // the reel spins up under tension (a sudden full-speed reel would jerk the hero), stops when slack
      ph.reelRate = d >= len - 1e-3 ? Math.min(CFG.reelSpeed, ph.reelRate + CFG.reelAccel * h) : 0;
      if (d < len) len = Math.max(CFG.minRopeLen, d); // take up slack (no force: it never moves the hero)
      if (len > p.ropeMin) len = Math.max(p.ropeMin, len - ph.reelRate * h); // reel in under tension
      ph.rope.distance = p.ropeLen = len;
    }
    ph.world.step(h);
    if (ph.rope) {
      if (v.y <= 0) p.sawDescent = true;
      if (p.swingPhase === 'descending' && p.sawDescent && v.y > 0) { p.swingPhase = 'ascending'; events.push('bottom'); }
    }
    // standing on a roof with no rope: run forward so a landing never leaves the hero stuck
    if (!ph.rope && hero.position.y > 1 && raycast(ph, hero.position, DOWN, CFG.heroRadius + 0.15)) {
      v.z = Math.max(v.z, CFG.roofRunSpeed);
    }
    if (hero.position.y <= CFG.heroRadius + 0.05) { // touching the street
      release(ph, p);
      hero.velocity.setZero();
      p.alive = false;
      events.push('dead');
      break;
    }
  }
  if (ph.bounced) { ph.bounced = false; events.push('bounce'); }
  copy(hero.position, p.pos);
  copy(hero.velocity, p.vel);
  return events;
}
