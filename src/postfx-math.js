// Pure curves for postfx.js (no three.js, so Node tests can load it). Speeds in m/s, vel in world coords (y up).
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

export const FX = {
  blurSpeed: [21, 32], // |vel| where the edge blur starts / is full (bot swings peak ~29 m/s at the bottom)
  blurSpeedMax: 0.75, // a fast flat swing never blurs as hard as a dive
  dive: [10, 26], // -vy where the dive term starts / is full
  fovSpeed: [27, 38], // the fov kick only comes at high speed...
  fovKickMax: 8, // ...and never more than this many degrees over render.js's 60-68 (the user saw fisheye at 100+)
  easeIn: 5, easeOut: 2, // 1/s
  frameLimit: 0.020, holdSec: 2, // auto-disable: frame time above 20 ms for 2 s
};

// Target {blur 0..1, fov degrees} for this velocity.
export function fxTargets(vel) {
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  const dive = smooth((-vel.y - FX.dive[0]) / (FX.dive[1] - FX.dive[0]));
  const s = (r) => smooth((speed - r[0]) / (r[1] - r[0]));
  return {
    blur: Math.max(FX.blurSpeedMax * s(FX.blurSpeed), dive),
    fov: FX.fovKickMax * Math.max(s(FX.fovSpeed), dive),
  };
}

// Frame-rate independent ease toward target: quicker in than out.
export const ease = (cur, target, dt) =>
  cur + (target - cur) * (1 - Math.exp(-(target > cur ? FX.easeIn : FX.easeOut) * dt));

// tick(frameSec) -> false once the smoothed frame time has stayed above limit for hold seconds; it stays off.
export function createFrameGuard(limit = FX.frameLimit, hold = FX.holdSec) {
  let avg = 1 / 60, over = 0, off = false;
  return {
    tick(sec) {
      if (off) return false;
      if (!(sec > 0) || sec > 0.25) return true; // a hitch or a tab switch, not a slow GPU
      avg += (sec - avg) * 0.1;
      over = avg > limit ? over + sec : 0;
      off = over >= hold;
      return !off;
    },
    get off() { return off; },
  };
}
