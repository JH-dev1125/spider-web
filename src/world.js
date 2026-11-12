// Endless level generator. Pure data: axis-aligned boxes in world metres (x right, y up, z forward, street y = 0).
// Structure: { id, kind, min:{x,y,z}, max:{x,y,z}, attach } — the renderer contract documented in game.js.
import { CFG } from './config.js';

// mulberry32
const STEP = 0x6D2B79F5;
const mix01 = (a) => {
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const makeRng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + STEP) >>> 0;
    return mix01(a);
  };
};
// Allocation-free stateless hash: hash01(n) === makeRng(n)(), any integer n (negatives wrap mod 2^32).
export const hash01 = (n) => mix01(((n >>> 0) + STEP) >>> 0);

const L = CFG.level;
const W = CFG.corridorHalfWidth;
const lerp = (a, b, p) => a + (b - a) * p;
const lerp2 = (a, b, p) => [lerp(a[0], b[0], p), lerp(a[1], b[1], p)];
const range = (rng, [a, b]) => a + (b - a) * rng();

// Difficulty by course distance z (not time), so a course is the same whatever the player's speed.
export const difficulty = (z) => {
  const p = Math.min(1, Math.max(0, (z - L.easyZ) / L.rampZ));
  const weights = {};
  for (const k of Object.keys(L.weightsEnd)) weights[k] = lerp(L.weightsStart[k], L.weightsEnd[k], p);
  return {
    p,
    maxGap: lerp(L.maxGapStart, L.maxGapEnd, p),
    alley: lerp2(L.alleyStart, L.alleyEnd, p),
    towerH: lerp2(L.towerHStart, L.towerHEnd, p),
    oneSide: lerp(L.oneSideStart, L.oneSideEnd, p),
    bridge: lerp(L.bridgeStart, L.bridgeEnd, p),
    weights,
  };
};

const pick = (rng, weights) => {
  const keys = Object.keys(weights).filter((k) => weights[k] > 0);
  let r = rng() * keys.reduce((s, k) => s + weights[k], 0);
  for (const k of keys) if ((r -= weights[k]) < 0) return k;
  return keys[keys.length - 1];
};

// A sure anchor: a solid tower block on the corridor face, tall enough for a mid or hi web from flight height.
export const isSureAnchor = (s) => s.kind === 'tower' && s.attach && s.max.y >= L.goodH
  && (Math.abs(s.min.x - W) < 1e-9 || Math.abs(s.max.x + W) < 1e-9);

export const createWorld = (seed = 1) => ({
  rng: makeRng(seed),
  structures: [],
  nextZ: { L: L.startZ, R: L.startZ }, // each side's frontier
  coverEnd: L.startZ, // furthest z covered by a sure anchor on either side
  section: { end: L.startZ, mode: 'both' }, // 'both' | 'L' | 'R': which sides are built up
  towers: { L: [], R: [] }, // sure-anchor towers still around, for skybridges
  nextId: 0,
});

// Box on side sd (-1 left, +1 right) spanning a..b metres out from the corridor centre (a < b; a < 0 crosses it).
const box = (id, kind, sd, a, b, y0, y1, z0, z1, attach) => ({
  id, kind, attach,
  min: { x: sd > 0 ? a : -b, y: y0, z: z0 },
  max: { x: sd > 0 ? b : -a, y: y1, z: z1 },
});

const lotLen = (rng, kind) => (kind === 'tower' || kind === 'low' ? range(rng, L.towerLen)
  : kind === 'frame' ? range(rng, L.frameLen) : kind === 'crane' ? L.craneLot : range(rng, L.gapLen));

function tower(w, side, sd, id, z0, z1, d) {
  const { rng, structures: out } = w;
  const h = range(rng, d.towerH);
  const depth = range(rng, L.depth);
  out.push(box(`${id}:base`, 'tower', sd, W, W + depth, 0, h, z0, z1, true));
  if (rng() < L.setbackChance) {
    out.push(box(`${id}:setback`, 'setback', sd, W + range(rng, L.setbackInset), W + depth, h, h + range(rng, L.setbackH), z0 + 2, z1 - 2, true));
  }
  if (rng() < L.ledgeChance) {
    const ly = range(rng, [10, h - 10]), lz = z0 + range(rng, [2, z1 - z0 - 8]);
    out.push(box(`${id}:ledge`, 'ledge', sd, W - 1.2, W, ly, ly + 1, lz, lz + 6, true));
  }
  w.coverEnd = Math.max(w.coverEnd, z1);
  // skybridge to a tower across the street that overlaps this one by enough z, both ends buried in the towers
  for (const o of w.towers[side === 'L' ? 'R' : 'L']) {
    const a = Math.max(z0, o.z0) + 2, b = Math.min(z1, o.z1) - 7;
    const top = Math.min(h, o.h) - 6;
    if (b <= a || top <= L.bridgeY[0] + 3 || rng() >= d.bridge) continue;
    const y = range(rng, [L.bridgeY[0], Math.min(L.bridgeY[1], top - 3)]), bz = range(rng, [a, b]);
    out.push(box(`${id}:bridge`, 'bridge', 1, -W - 2, W + 2, y, y + 3, bz, bz + 5, true));
    break;
  }
  w.towers[side].push({ z0, z1, h });
}

function frame(w, sd, id, z0, z1) {
  const { rng, structures: out } = w;
  const depth = range(rng, L.frameDepth), h = range(rng, L.frameH), t = L.beam;
  let n = 0;
  for (const a of [W, W + depth - t]) for (const z of [z0, z1 - t]) out.push(box(`${id}:post${n++}`, 'frame', sd, a, a + t, 0, h, z, z + t, false));
  n = 0;
  for (const a of [W, W + depth - t]) out.push(box(`${id}:beam${n++}`, 'frame', sd, a, a + t, h - t, h, z0, z1, false));
  for (const z of [z0, z1 - t]) out.push(box(`${id}:beam${n++}`, 'frame', sd, W, W + depth, h - t, h, z, z + t, false));
}

function crane(w, sd, id, z0, z1) {
  const { rng, structures: out } = w;
  const zc = (z0 + z1) / 2, H = range(rng, L.craneH);
  out.push(box(`${id}:mast`, 'crane', sd, W + 3, W + 6, 0, H, zc - 1.5, zc + 1.5, true));
  out.push(box(`${id}:jib`, 'crane', sd, W - range(rng, L.craneReach), W + 14, H, H + 3, zc - 1.5, zc + 1.5, true));
}

// One lot on the side with the lower frontier. The guarantee: a lot that is not a sure anchor is only placed
// if a sure anchor can still start within maxGap of coverEnd afterwards; otherwise it becomes a tower, pulled
// forward so it starts by coverEnd + maxGap. Lots are placed at the lower frontier, so this holds by induction.
function placeLot(w, side) {
  const { rng } = w;
  const other = w.nextZ[side === 'L' ? 'R' : 'L'];
  const f = w.nextZ[side];
  const d = difficulty(f);
  if (f >= w.section.end) {
    const mode = rng() < d.oneSide ? (rng() < 0.5 ? 'L' : 'R') : 'both';
    w.section = { end: f + range(rng, L.sectionLen), mode };
  }
  const built = w.section.mode === 'both' || w.section.mode === side;
  let kind = pick(rng, built ? d.weights : L.offWeights);
  let z0 = f + range(rng, d.alley);
  let len = lotLen(rng, kind);
  if (kind !== 'tower' && Math.min(z0 + len, other) - w.coverEnd > d.maxGap) {
    kind = 'tower';
    len = lotLen(rng, kind);
  }
  if (kind === 'tower') z0 = Math.min(z0, Math.max(f, w.coverEnd + d.maxGap));
  const z1 = z0 + len, sd = side === 'L' ? -1 : 1, id = `${side}${w.nextId++}`;
  if (kind === 'tower') tower(w, side, sd, id, z0, z1, d);
  else if (kind === 'low') w.structures.push(box(`${id}:base`, 'tower', sd, W, W + range(rng, L.depth), 0, range(rng, L.lowH), z0, z1, true));
  else if (kind === 'frame') frame(w, sd, id, z0, z1);
  else if (kind === 'crane') crane(w, sd, id, z0, z1);
  w.nextZ[side] = z1;
}

export const updateWorld = (w, playerZ) => {
  const horizon = playerZ + CFG.viewDistance;
  while (Math.min(w.nextZ.L, w.nextZ.R) < horizon) placeLot(w, w.nextZ.L <= w.nextZ.R ? 'L' : 'R');
  const back = playerZ - CFG.behindDistance;
  if (w.structures.some((s) => s.max.z < back)) w.structures = w.structures.filter((s) => s.max.z >= back);
  for (const s of ['L', 'R']) w.towers[s] = w.towers[s].filter((t) => t.z1 >= back);
};
