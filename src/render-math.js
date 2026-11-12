// Pure camera math for render.js. No three.js import, so Node tests can load it.
// Everything here is in world coordinates (x right, y up, z forward).
import { CFG } from './config.js';

const R = CFG.render;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 0 at baseSpeed, 1 at maxSpeed
export const speedK = (vel) =>
  clamp01((Math.hypot(vel.x, vel.y, vel.z) - CFG.baseSpeed) / (CFG.maxSpeed - CFG.baseSpeed));

// Follow cam: behind and above the hero, looking a little ahead along the velocity. Exponential smoothing
// with dt, so two half steps equal one full step. z leads by vel.z / rate so the steady-state distance stays
// camBack at any speed; x/y lag a little on purpose (the swing reads as motion).
export function followCamera(player, prev, dt) {
  const { pos, vel } = player;
  const fov = R.fovMin + (R.fovMax - R.fovMin) * speedK(vel);
  // Bias toward the street, continuously following the hero beyond the corridor as well.
  const x = pos.x - Math.sign(pos.x) * Math.min(Math.abs(pos.x) * R.camWallGap / CFG.corridorHalfWidth, R.camWallGap);
  const y = pos.y + R.camUp, z = pos.z - R.camBack;
  // look straight down the street from the camera, not sideways at a hero hugging a wall
  const lx = x + vel.x * R.lookAhead, ly = pos.y + R.lookUp + vel.y * R.lookAhead, lz = pos.z + vel.z * R.lookAhead;
  // no prev, or a restart teleported the hero: snap
  const snap = !prev || Math.abs(prev.z - z) > R.camSnap;
  const a = 1 - Math.exp(-CFG.camFollow * dt);
  const b = 1 - Math.exp(-CFG.fovFollow * dt);
  const tz = z + vel.z / CFG.camFollow, tlz = lz + vel.z / CFG.camFollow;
  const c = snap ? { x, y, z, lx, ly, lz, fovDeg: fov } : {
    x: prev.x + (x - prev.x) * a,
    y: prev.y + (y - prev.y) * a,
    z: prev.z + (tz - prev.z) * a,
    lx: prev.lx + (lx - prev.lx) * a,
    ly: prev.ly + (ly - prev.ly) * a,
    lz: prev.lz + (tlz - prev.lz) * a,
    fovDeg: prev.fovDeg + (fov - prev.fovDeg) * b,
  };
  return c;
}

// Physics anchors can land on any box face, including the underside of a skybridge.
export function surfaceNormal(point, structures) {
  let best = Infinity, normal = { x: 0, y: 1, z: 0 };
  for (const s of structures) {
    if (['x', 'y', 'z'].some(k => point[k] < s.min[k] - 0.1 || point[k] > s.max[k] + 0.1)) continue;
    for (const axis of ['x', 'y', 'z']) for (const side of ['min', 'max']) {
      const d = Math.abs(point[axis] - s[side][axis]);
      if (d < best) { best = d; normal = { x: 0, y: 0, z: 0 }; normal[axis] = side === 'min' ? -1 : 1; }
    }
  }
  return normal;
}

// Camera offset in metres (screen x, screen y) for view.shake at time t.
export const shakeOffset = (shake, t) => [
  Math.sin(t * R.shakeFreqX) * shake * R.shakeM,
  Math.cos(t * R.shakeFreqY) * shake * R.shakeM,
];

// Speed-line strength 0..1 from the speed in m/s.
export const speedLineK = (speed) =>
  clamp01((speed - CFG.baseSpeed * R.speedLineStart) / (CFG.baseSpeed * (R.speedLineFull - R.speedLineStart)));

// Skyline/street wrap: the copy of a world-fixed z that lies in [camZ - back, camZ - back + span).
export const wrapZ = (z, camZ, back, span) => camZ - back + ((((z - camZ + back) % span) + span) % span);
