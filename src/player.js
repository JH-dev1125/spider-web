import { CFG } from './config.js';

export const createPlayer = () => ({
  pos: { x: 0, y: CFG.startHeight, z: 0 },
  vel: { x: 0, y: 0, z: CFG.baseSpeed },
  anchor: null,
  ropeLen: 0,
  swingPhase: 'none',
  sawDescent: false,
  alive: true,
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Returns false (miss) for anchors too close to swing on, e.g. casting into the face the player slides along.
export function attach(p, point) {
  const len = dist(p.pos, point);
  if (len < CFG.minRopeLen) return false;
  p.anchor = { ...point };
  p.ropeLen = len * CFG.reelFactor;
  p.swingPhase = 'descending';
  p.sawDescent = false;
  return true;
}

export function detach(p) {
  p.anchor = null;
  p.swingPhase = 'none';
}

// Player let go of the key: detach, plus the boost once the swing has passed its bottom
// (tapping press/release must not pump height). Returns true if a rope was attached.
export function release(p) {
  if (!p.anchor) return false;
  if (p.swingPhase === 'ascending') {
    p.vel.y += CFG.releaseBoostUp;
    p.vel.z += CFG.releaseBoostForward;
  }
  detach(p);
  return true;
}

// Rope constraint and phase tracking. Pushes 'bottom'. The rope holds until release() (player input).
function swing(p, events) {
  const { pos, vel, anchor: a } = p;
  const d = { x: pos.x - a.x, y: pos.y - a.y, z: pos.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len > p.ropeLen) {
    const n = { x: d.x / len, y: d.y / len, z: d.z / len };
    pos.x = a.x + n.x * p.ropeLen;
    pos.y = a.y + n.y * p.ropeLen;
    pos.z = a.z + n.z * p.ropeLen;
    const vn = vel.x * n.x + vel.y * n.y + vel.z * n.z;
    if (vn > 0) { vel.x -= vn * n.x; vel.y -= vn * n.y; vel.z -= vn * n.z; }
  }
  if (vel.y <= 0) p.sawDescent = true;
  // ascending only after passing the lowest point (spec 5.3)
  if (p.swingPhase === 'descending' && p.sawDescent && vel.y > 0) {
    p.swingPhase = 'ascending';
    events.push('bottom');
  }
}

export function stepPlayer(p, dt, buildings, minForwardSpeed) {
  const events = [];
  if (!p.alive) return events;
  dt = Math.min(dt, CFG.maxDt);
  const { pos, vel } = p;
  pos.x += vel.x * dt;
  pos.y += (vel.y - 0.5 * CFG.gravity * dt) * dt; // exact ballistic step under constant g
  pos.z += vel.z * dt;
  vel.y -= CFG.gravity * dt;

  // Walls before the rope: anchors sit on the face plane, so the rope projection
  // only pulls toward |x| = W and can never push back through the wall.
  const W = CFG.corridorHalfWidth;
  if (Math.abs(pos.x) >= W - CFG.wallSkin) {
    const s = Math.sign(pos.x);
    const side = s > 0 ? 'R' : 'L';
    const wall = buildings.some((b) => b.side === side && pos.z >= b.z0 && pos.z <= b.z1 && pos.y < b.h);
    const out = vel.x * s; // outward speed
    if (wall) {
      pos.x = s * (W - CFG.wallSkin);
      if (out > CFG.bounceMinSpeed) {
        vel.x = -vel.x * CFG.wallBounceLoss;
        events.push('bounce');
      } else if (!p.anchor) {
        // free flight never sticks to a face, or every same-side web would be too short (spec 1.1)
        vel.x = -s * Math.max(CFG.wallPushOff, -out);
      } else if (out > 0) vel.x = 0; // slow contact (rope drag): slide along the face
    } else if (Math.abs(pos.x) >= W) {
      pos.x = s * W;
      if (out > 0) vel.x = 0;
    }
  }
  if (pos.y > CFG.ceiling) {
    pos.y = CFG.ceiling;
    vel.y = Math.min(vel.y, 0);
  }
  if (p.anchor) swing(p, events);
  // floor only in free flight: on a held rope it would pump energy forever and orbit the anchor
  else vel.z = Math.max(vel.z, minForwardSpeed);
  if (pos.y <= 0) {
    p.alive = false;
    events.push('dead');
  }
  return events;
}
