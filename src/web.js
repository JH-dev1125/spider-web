import { CFG } from './config.js';

const RAD = Math.PI / 180;

// Unit web direction for a hero at lateral position x. The yaw is chosen so the web meets that side's corridor
// face CFG.aimAhead metres ahead wherever the hero is across the street (a fixed yaw would put the far wall
// ~100 m ahead from beside the near one). The pitch is fixed per level. ahead: that distance (game.js pushes it past an
// intersection, so a web never dives into the gap).
export function aimVector(side, level, x = 0, ahead = CFG.aimAhead) {
  if (side === 'C') { const up = CFG.aimUpDeg[level] * RAD; return { x: 0, y: Math.sin(up), z: Math.cos(up) }; } // W: along the street, steeply up
  const sign = side === 'L' ? -1 : 1;
  const lat = Math.max(1, CFG.corridorHalfWidth - sign * x), yaw = Math.atan2(lat, ahead);
  // pushed further ahead (past an intersection) the web keeps the same rise, not the same pitch: hi ~+50 m, mid ~+30,
  // lo ~+12 above the hand wherever it lands (a fixed pitch 70 m ahead threw webs ~90 m up)
  const pitch0 = CFG.aimPitchDeg[level] * RAD, rise = Math.tan(pitch0) * Math.hypot(lat, CFG.aimAhead);
  const pitch = ahead > CFG.aimAhead ? Math.atan2(rise, Math.hypot(lat, ahead)) : pitch0;
  return {
    x: sign * Math.cos(pitch) * Math.sin(yaw),
    y: Math.sin(pitch),
    z: Math.cos(pitch) * Math.cos(yaw),
  };
}
