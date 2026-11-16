// Pure camera math for render.js. No three.js import, so Node tests can load it.
// Everything here is in world coordinates (x right, y up, z forward).
import { CFG } from './config.js';
import { toLocal, yawOf } from './street.js';

const R = CFG.render;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 0 at baseSpeed, 1 at maxSpeed
export const speedK = (vel) =>
  clamp01((Math.hypot(vel.x, vel.y, vel.z) - CFG.baseSpeed) / (CFG.maxSpeed - CFG.baseSpeed));

// Pull point q (an {x,y,z} with the given keys) to within max of centre c.
function leash(q, c, max, [kx, ky, kz]) {
  const dx = q[kx] - c.x, dy = q[ky] - c.y, dz = q[kz] - c.z, d = Math.hypot(dx, dy, dz);
  if (d <= max) return;
  const k = max / d;
  q[kx] = c.x + dx * k; q[ky] = c.y + dy * k; q[kz] = c.z + dz * k;
}

// Spring arm: if a structure box (+ camBoxMargin) cuts the line from the hero to the camera, the camera moves in
// along that line to just before it, so no tower, crane or bridge hides him and it never sits inside one.
function outOfBoxes(c, pos, structures) {
  const m = R.camBoxMargin, d = { x: c.x - pos.x, y: c.y - pos.y, z: c.z - pos.z };
  let t = 1;
  for (const s of structures) {
    if (s.kind === 'ledge' || s.kind === 'frame') continue; // thin: hiding him for a frame beats jamming the camera into him
    let t0 = 0, t1 = 1;
    for (const k of ['x', 'y', 'z']) {
      const lo = s.min[k] - m - pos[k], hi = s.max[k] + m - pos[k];
      if (Math.abs(d[k]) < 1e-9) { if (lo > 0 || hi < 0) { t0 = 2; break; } continue; }
      const a = lo / d[k], b = hi / d[k];
      t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 <= t1 && t0 > 1e-6 && t0 < t) t = t0; // t0 = 0: the hero himself is within the margin (a corner graze)
  }
  if (t < 1) { c.x = pos.x + d.x * t * 0.98; c.y = pos.y + d.y * t * 0.98; c.z = pos.z + d.z * t * 0.98; }
}

// Follow cam: behind and above the hero along the street heading, looking a little ahead along the velocity.
// It works in the frame of its own yaw, which eases toward the street heading (camTurnFollow) no faster than
// camTurnRate deg/s, so a corner turn swings the view round smoothly and frame-rate independently. Exponential
// smoothing with dt, so two half steps equal one full step. Every axis leads by vel / rate, which cancels the lag that
// smoothing a moving target has, so in steady flight the offset is exact at any speed and direction.
// A hard leash keeps the camera within camLeash x its desired distance of the hero (he stays >= ~1/5 of the
// screen through swing ends, releases and zips) and behind him; it never goes inside a structure (structures
// = the view's boxes). At the corridor faces it sits camWallGap toward the street from the hero.
// street: the view's street frame (street.js); omitted = the start street (+z along x = 0). Returns world coords
// {x, y, z, lx, ly, lz, fovDeg, yaw}.
const START = { axis: 'z', lat: 'x', dir: 1, centre: 0 };
const wrapPi = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
export function followCamera(player, prev, dt, structures = [], street = START) {
  const want = yawOf(street);
  let yaw = want;
  if (prev && prev.yaw !== undefined) {
    const d = wrapPi(want - prev.yaw), cap = CFG.camTurnRate * Math.PI / 180 * dt;
    yaw = prev.yaw + Math.sign(d) * Math.min(Math.abs(d) * (1 - Math.exp(-CFG.camTurnFollow * dt)), cap);
  }
  // camera frame: x right, z ahead along yaw (about the world origin; only the corridor offset uses the street)
  const sn = Math.sin(yaw), cs = Math.cos(yaw);
  const toL = (q) => ({ x: q.x * cs - q.z * sn, y: q.y, z: q.x * sn + q.z * cs });
  const toW = (q) => ({ x: q.x * cs + q.z * sn, y: q.y, z: -q.x * sn + q.z * cs });
  const pos = toL(player.pos), vel = toL(player.vel);
  const off = toLocal(street, player.pos).x; // across his street, from its centreline
  const fov = R.fovMin + (R.fovMax - R.fovMin) * speedK(vel);
  const x = pos.x - Math.sign(off) * Math.min(Math.abs(off) * R.camWallGap / CFG.corridorHalfWidth, R.camWallGap);
  const y = pos.y + R.camUp, z = pos.z - R.camBack;
  // look down the street, halfway between the camera's line and the hero's (he hugs a wall: still near the middle)
  // sideways and up/down the lead is capped, or a fast zip, fall or wall jump swings the hero to the frame's edge
  const side = (v) => Math.max(-R.lookMaxSide, Math.min(R.lookMaxSide, v * R.lookAhead));
  const lx = (x + pos.x) / 2 + side(vel.x), ly = pos.y + R.lookUp + side(vel.y), lz = pos.z + Math.max(vel.z * R.lookAhead, R.camBack * 0.6);
  const pc = prev && toL(prev), pl = prev && toL({ x: prev.lx, y: prev.ly, z: prev.lz });
  // no prev, or a restart teleported the hero: snap
  const snap = !prev || Math.hypot(pc.x - x, pc.y - y, pc.z - z) > R.camSnap;
  const k = CFG.camFollow, a = 1 - Math.exp(-k * dt), b = 1 - Math.exp(-CFG.fovFollow * dt);
  const ex = vel.x / k, ey = vel.y / k, ez = vel.z / k;
  const c = snap ? { x, y, z, lx, ly, lz, fovDeg: fov } : {
    x: pc.x + (x + ex - pc.x) * a,
    y: pc.y + (y + ey - pc.y) * a,
    z: pc.z + (z + ez - pc.z) * a,
    lx: pl.x + (lx + ex - pl.x) * a,
    ly: pl.y + (ly + ey - pl.y) * a,
    lz: pl.z + (lz + ez - pl.z) * a,
    fovDeg: prev.fovDeg + (fov - prev.fovDeg) * b,
  };
  const dist = Math.hypot(x - pos.x, y - pos.y, z - pos.z);
  leash(c, pos, dist * CFG.camLeash, ['x', 'y', 'z']);
  c.z = Math.min(c.z, pos.z - R.camBack * 0.5); // never level with or ahead of him..
  leash(c, { x: lx, y: ly, z: lz }, dist * (CFG.camLeash - 1), ['lx', 'ly', 'lz']); // the look point stays near his..
  c.lz = Math.max(c.lz, pos.z + R.camBack * 0.6); // ..and always ahead of him, even when he flies backward
  const cw = toW(c), lw = toW({ x: c.lx, y: c.ly, z: c.lz });
  const out = { x: cw.x, y: cw.y, z: cw.z, lx: lw.x, ly: lw.y, lz: lw.z, fovDeg: c.fovDeg, yaw };
  outOfBoxes(out, player.pos, structures);
  return out;
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
