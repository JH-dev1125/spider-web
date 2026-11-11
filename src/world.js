import { CFG } from './config.js';

// mulberry32
export const makeRng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const lerp = (a, b, p) => a + (b - a) * p;

export const difficulty = (elapsedSec) => {
  const e = Math.max(0, elapsedSec - CFG.easySeconds);
  const p = Math.min(1, e / CFG.rampSeconds);
  return {
    speed: Math.min(CFG.maxSpeed, CFG.baseSpeed + e * CFG.speedRampPerSec),
    gapMin: lerp(CFG.gapMinStart, CFG.gapMinEnd, p),
    gapMax: lerp(CFG.gapMaxStart, CFG.gapMaxEnd, p),
    lenMin: CFG.lenMin,
    lenMax: CFG.lenMax,
    hMin: CFG.startHeight * lerp(CFG.hMinStartFactor, CFG.hMinEndFactor, p),
    hMax: CFG.ceiling * CFG.hMaxFactor,
  };
};

export const createWorld = () => ({
  buildings: [],
  nextZ: { L: CFG.startZ, R: CFG.startZ },
});

export const updateWorld = (world, playerZ, elapsedSec, rng) => {
  const d = difficulty(elapsedSec);
  const horizon = playerZ + CFG.viewDistance;
  for (const side of ['L', 'R']) {
    while (world.nextZ[side] < horizon) {
      const first = !world.buildings.some((b) => b.side === side);
      const z0 = world.nextZ[side] + (first ? 0 : lerp(d.gapMin, d.gapMax, rng()));
      const z1 = z0 + lerp(d.lenMin, d.lenMax, rng());
      // first building per side is always swingable from the start
      const h = lerp(first ? CFG.startHeight : d.hMin, d.hMax, rng());
      world.buildings.push({ side, z0, z1, h });
      world.nextZ[side] = z1;
    }
  }
  world.buildings = world.buildings.filter((b) => b.z1 >= playerZ - CFG.behindDistance);
};
