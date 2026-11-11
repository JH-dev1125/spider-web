import { CFG } from './config.js';

const RAD = Math.PI / 180;

export function aimVector(side, level) {
  const yaw = CFG.aimYawDeg * RAD;
  const pitch = CFG.aimPitchDeg[level] * RAD;
  const sign = side === 'L' ? -1 : 1;
  return {
    x: sign * Math.cos(pitch) * Math.sin(yaw),
    y: Math.sin(pitch),
    z: Math.cos(pitch) * Math.cos(yaw),
  };
}

export function chargeLength(heldSec) {
  const k = Math.min(Math.max(heldSec / CFG.chargeFullSec, 0), 1);
  return CFG.chargeMin + (CFG.chargeMax - CFG.chargeMin) * k;
}

export function castWeb(origin, dir, length, buildings) {
  let best = null;
  let bestT = Infinity;
  for (const b of buildings) {
    const xFace = (b.side === 'L' ? -1 : 1) * CFG.corridorHalfWidth;
    if (dir.x === 0) continue;
    const t = (xFace - origin.x) / dir.x;
    if (!(t > 0 && t <= length) || t >= bestT) continue;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    if (y < 0 || y > b.h || z < b.z0 || z > b.z1) continue;
    bestT = t;
    best = { x: xFace, y, z };
  }
  return best;
}
