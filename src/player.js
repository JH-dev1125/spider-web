import { CFG } from './config.js';

const RAD = Math.PI / 180;

export const createPlayer = () => ({
  pos: { x: 0, y: CFG.startHeight, z: 0 },
  vel: { x: 0, y: 0, z: CFG.baseSpeed },
  anchor: null,
  ropeLen: 0,
  swingPhase: 'none',
  alive: true,
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function attach(p, point) {
  p.anchor = { ...point };
  p.ropeLen = dist(p.pos, point) * CFG.reelFactor;
  p.swingPhase = 'descending';
}

export function detach(p) {
  p.anchor = null;
  p.swingPhase = 'none';
}

// Rope constraint, phase tracking and auto-release. Returns true if released.
function swing(p) {
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
  if (p.swingPhase === 'descending' && vel.y > 0) p.swingPhase = 'ascending';
  // rope angle from vertical, positive when the anchor is behind the player (z)
  const backDeg = Math.atan2(pos.z - a.z, a.y - pos.y) / RAD;
  if (p.swingPhase === 'ascending' && (vel.y <= 0 || backDeg > CFG.autoReleaseBackAngleDeg)) {
    detach(p);
    vel.y += CFG.releaseBoostUp;
    vel.z += CFG.releaseBoostForward;
    return true;
  }
  return false;
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
  if (Math.abs(pos.x) >= W) {
    const s = Math.sign(pos.x);
    const side = s > 0 ? 'R' : 'L';
    const wall = buildings.some((b) => b.side === side && pos.z >= b.z0 && pos.z <= b.z1 && pos.y < b.h);
    const out = vel.x * s; // outward speed
    if (wall) {
      pos.x = s * (W - CFG.wallSkin);
      if (out > CFG.bounceMinSpeed) {
        vel.x = -vel.x * CFG.wallBounceLoss;
        events.push('bounce');
      } else if (out > 0) vel.x = 0; // slow contact (rope drag): slide along the face
    } else {
      pos.x = s * W;
      if (out > 0) vel.x = 0;
    }
  }
  if (pos.y > CFG.ceiling) {
    pos.y = CFG.ceiling;
    vel.y = Math.min(vel.y, 0);
  }
  if (p.anchor && swing(p)) events.push('released');
  vel.z = Math.max(vel.z, minForwardSpeed);
  if (pos.y <= 0) {
    p.alive = false;
    events.push('dead');
  }
  return events;
}
