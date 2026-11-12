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
  const wall = CFG.corridorHalfWidth - R.camWallGap; // never put the lens inside a facade
  const x = Math.max(-wall, Math.min(wall, pos.x)), y = pos.y + R.camUp, z = pos.z - R.camBack;
  const lx = pos.x + vel.x * R.lookAhead, ly = pos.y + R.lookUp + vel.y * R.lookAhead, lz = pos.z + vel.z * R.lookAhead;
  // no prev, or a restart teleported the hero: snap
  if (!prev || Math.abs(prev.z - z) > R.camSnap) return { x, y, z, lx, ly, lz, fovDeg: fov };
  const a = 1 - Math.exp(-CFG.camFollow * dt);
  const b = 1 - Math.exp(-CFG.fovFollow * dt);
  const tz = z + vel.z / CFG.camFollow, tlz = lz + vel.z / CFG.camFollow;
  return {
    x: prev.x + (x - prev.x) * a,
    y: prev.y + (y - prev.y) * a,
    z: prev.z + (tz - prev.z) * a,
    lx: prev.lx + (lx - prev.lx) * a,
    ly: prev.ly + (ly - prev.ly) * a,
    lz: prev.lz + (tlz - prev.lz) * a,
    fovDeg: prev.fovDeg + (fov - prev.fovDeg) * b,
  };
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
