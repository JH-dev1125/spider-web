import { CFG } from './config.js';

const RAD = Math.PI / 180;

// Unit web direction for a hero at lateral position x. The yaw is chosen so the web meets that side's corridor
// face CFG.aimAhead metres ahead wherever the hero is across the street (a fixed yaw would put the far wall
// ~100 m ahead from beside the near one). The pitch is fixed per level.
export function aimVector(side, level, x = 0) {
  const sign = side === 'L' ? -1 : 1;
  const yaw = Math.atan2(Math.max(1, CFG.corridorHalfWidth - sign * x), CFG.aimAhead);
  const pitch = CFG.aimPitchDeg[level] * RAD;
  return {
    x: sign * Math.cos(pitch) * Math.sin(yaw),
    y: Math.sin(pitch),
    z: Math.cos(pitch) * Math.cos(yaw),
  };
}
