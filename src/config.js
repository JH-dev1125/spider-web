const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const CFG = deepFreeze({
  maxDt: 0.05,
  gravity: 18,
  corridorHalfWidth: 14,
  viewDistance: 260,
  behindDistance: 40,
  startHeight: 45,
  ceiling: 140,
  baseSpeed: 22,
  maxSpeed: 60,
  speedRampPerSec: 0.25,
  easySeconds: 20,
  chargeMin: 12,
  chargeMax: 70,
  chargeFullSec: 1.0,
  reelFactor: 0.85,
  releaseBoostUp: 6,
  releaseBoostForward: 4,
  wallBounceLoss: 0.5,
  autoReleaseBackAngleDeg: 35,
  missShowSec: 0.25,
  keys: {
    KeyQ: ['L', 'hi'], KeyA: ['L', 'mid'], KeyZ: ['L', 'lo'],
    KeyE: ['R', 'hi'], KeyD: ['R', 'mid'], KeyC: ['R', 'lo'],
  },
});
