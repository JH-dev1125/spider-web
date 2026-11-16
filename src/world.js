// Endless city generator. Pure data: axis-aligned boxes in world metres (x right, y up, z forward, street y = 0).
// Structure: { id, kind, min:{x,y,z}, max:{x,y,z}, attach, face? } — the renderer contract documented in game.js.
//
// A Manhattan grid: z-streets at x = colX(i) and x-streets at z = rowZ(j), each corridorHalfWidth wide, lines
// 120-200 m apart. Every block corner holds a tall solid corner tower; between two corners a street segment's two
// faces are filled lot by lot (towers, low towers, frames, cranes, bridges, one-sided stretches) by the difficulty
// ramp. Everything is a pure function of (seed, grid coordinates), so any route sees the same city; only the
// segments near the hero exist at a time.
import { CFG } from './config.js';
import { buildBuilding } from './archetypes.js';

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
// Seeded hash of a few integers -> [0, 1).
const hashN = (...n) => {
  let h = 0x811c9dc5;
  for (const k of n) { h = Math.imul(h ^ (k | 0), 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; }
  return hash01(h);
};

const L = CFG.level;
const W = CFG.corridorHalfWidth;
const BL = CFG.blockLen, JIT = CFG.blockJitter;
const lerp = (a, b, p) => a + (b - a) * p;
const lerp2 = (a, b, p) => [lerp(a[0], b[0], p), lerp(a[1], b[1], p)];
const range = (rng, [a, b]) => a + (b - a) * rng();

// Difficulty by distance from the start (|x| + |z|, not time), so a city is the same whatever the player's speed.
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

// ---- grid ----
// kind 'col': the z-street centrelines (x = lineAt(seed, 'col', i)); 'row': the x-streets (z = lineAt(seed, 'row', j)).
// col 0 is x = 0 (the start street); neighbouring lines are blockLen +- 2 blockJitter apart.
export const lineAt = (seed, kind, i) => (kind === 'col'
  ? (i === 0 ? 0 : i * BL + (hashN(seed, 1, i) - 0.5) * 2 * JIT)
  : i * BL + CFG.rowOffset + (hashN(seed, 2, i) - 0.5) * 2 * JIT);
// The index i with lineAt(i) <= v < lineAt(i + 1).
export const lineIndex = (seed, kind, v) => {
  let i = Math.floor((v - (kind === 'row' ? CFG.rowOffset : 0)) / BL);
  while (lineAt(seed, kind, i) > v) i--;
  while (lineAt(seed, kind, i + 1) <= v) i++;
  return i;
};
export const centreKind = (axis) => (axis === 'z' ? 'col' : 'row'); // a z-street's centreline is a col..
export const crossKind = (axis) => (axis === 'z' ? 'row' : 'col'); // ..and its cross streets are rows

// The col/row index whose corridor (grown by pad metres; negative = shrunk) holds v, or null.
export const corridorAt = (seed, kind, v, pad = 0) => {
  const i = lineIndex(seed, kind, v);
  return [i, i + 1].find((k) => Math.abs(lineAt(seed, kind, k) - v) <= W + pad) ?? null;
};

// Blocks are out of bounds (no roaming over roofs or through gaps between towers): a centre deeper than streetMargin
// inside a block is pushed back out through the nearest side and loses its velocity into the block. Mutates pos/vel ({x,y,z} or cannon Vec3). Returns true if it moved.
export function clampToStreets(seed, pos, vel) {
  const m = CFG.streetMargin, i = lineIndex(seed, 'col', pos.x), j = lineIndex(seed, 'row', pos.z);
  const x0 = lineAt(seed, 'col', i) + W + m, x1 = lineAt(seed, 'col', i + 1) - W - m;
  const z0 = lineAt(seed, 'row', j) + W + m, z1 = lineAt(seed, 'row', j + 1) - W - m;
  if (!(pos.x > x0 && pos.x < x1 && pos.z > z0 && pos.z < z1)) return false;
  const d = [pos.x - x0, x1 - pos.x, pos.z - z0, z1 - pos.z], k = d.indexOf(Math.min(...d));
  if (k === 0) { pos.x = x0; vel.x = Math.min(vel.x, 0); }
  else if (k === 1) { pos.x = x1; vel.x = Math.max(vel.x, 0); }
  else if (k === 2) { pos.z = z0; vel.z = Math.min(vel.z, 0); }
  else { pos.z = z1; vel.z = Math.max(vel.z, 0); }
  return true;
}

// ---- corner towers ----
// The tower in the (sx, sz) quadrant of intersection (col i, row j): a solid sure anchor flush with both street faces.
export function cornerTower(seed, i, j, sx, sz) {
  const q = (sx > 0 ? 1 : 0) + (sz > 0 ? 2 : 0), h = (k) => hashN(seed, 3, i, j, q, k);
  const cx = lineAt(seed, 'col', i), cz = lineAt(seed, 'row', j);
  const [d0, d1] = CFG.cornerDepth, ex = lerp(d0, d1, h(0)), ez = lerp(d0, d1, h(1));
  const d = difficulty(Math.abs(cx) + Math.abs(cz));
  const top = Math.max(L.goodH + 8, lerp(d.towerH[0], d.towerH[1], h(2)));
  const xa = cx + sx * W, xb = cx + sx * (W + ex), za = cz + sz * W, zb = cz + sz * (W + ez);
  return {
    id: `K${i}_${j}_${q}:base`, kind: 'tower', attach: true, face: `${sx > 0 ? '-' : '+'}x`,
    min: { x: Math.min(xa, xb), y: 0, z: Math.min(za, zb) }, max: { x: Math.max(xa, xb), y: top, z: Math.max(za, zb) },
  };
}
// The corner tower beside street (axis, line) at its cross line k, on lateral side sd (-1/+1 along lat), on the
// sv side (-1/+1 along axis) of the cross street.
export const cornerOf = (seed, axis, line, k, sd, sv) => (axis === 'z'
  ? cornerTower(seed, line, k, sd, sv) : cornerTower(seed, k, line, sv, sd));

// A sure anchor of the street with lateral axis lat and centreline c: a solid tower block on its corridor face,
// tall enough for a mid or hi web from flight height.
export const isSureAnchor = (s, lat = 'x', c = 0) => s.kind === 'tower' && s.attach && s.max.y >= L.goodH
  && (Math.abs(s.min[lat] - (c + W)) < 1e-9 || Math.abs(s.max[lat] - (c - W)) < 1e-9);

// ---- one street segment: the two faces of street (axis, line) between cross lines m and m + 1 ----
// Box on side sd (-1 / +1 along lat) spanning a..b metres out from the centreline (a < b; a < 0 crosses it),
// v0..v1 along the street.
const box = (w, id, kind, sd, a, b, y0, y1, v0, v1, attach) => {
  const s = { id: w.prefix + id, kind, attach, min: { x: 0, y: y0, z: 0 }, max: { x: 0, y: y1, z: 0 } };
  s.min[w.lat] = w.c + (sd > 0 ? a : -b); s.max[w.lat] = w.c + (sd > 0 ? b : -a);
  s.min[w.axis] = v0; s.max[w.axis] = v1;
  if (kind === 'tower') s.face = `${sd > 0 ? '-' : '+'}${w.lat}`; // the face toward the street (render detail)
  return s;
};

// The footprint of a lot on side sd, depth metres deep, v0..v1 along the street, for archetypes.buildBuilding
// (world footprint + streetSide = the street face's outward normal, so it works on x- and z-streets alike).
const lotOf = (w, id, sd, depth, v0, v1) => {
  const s = box(w, id, 'tower', sd, W, W + depth, 0, 0, v0, v1, true);
  return { id: s.id, x0: s.min.x, x1: s.max.x, z0: s.min.z, z1: s.max.z, streetSide: s.face };
};

// A lot clipped short at a corner can leave an archetype part with no room (size <= 0): drop those parts.
const building = (fp, h, rng, d) => buildBuilding(fp, h, rng, d).filter((b) => ['x', 'y', 'z'].every((k) => b.max[k] - b.min[k] > 0.05));

const lotLen = (rng, kind) => (kind === 'tower' || kind === 'low' ? range(rng, L.towerLen)
  : kind === 'frame' ? range(rng, L.frameLen) : kind === 'crane' ? L.craneLot : range(rng, L.gapLen));

function tower(w, side, sd, id, z0, z1, d) {
  const { rng, structures: out } = w;
  const h = range(rng, d.towerH);
  const depth = range(rng, L.depth);
  out.push(...building(lotOf(w, id, sd, depth, z0, z1), h, rng, d));
  w.coverEnd = Math.max(w.coverEnd, z1);
  // skybridge to a tower across the street that overlaps this one by enough length, both ends buried in the towers
  for (const o of w.towers[side === 'L' ? 'R' : 'L']) {
    const a = Math.max(z0, o.z0) + 2, b = Math.min(z1, o.z1) - 7;
    const top = Math.min(h, o.h) - 6;
    if (b <= a || top <= L.bridgeY[0] + 3 || rng() >= d.bridge) continue;
    const y = range(rng, [L.bridgeY[0], Math.min(L.bridgeY[1], top - 3)]), bz = range(rng, [a, b]);
    out.push(box(w, `${id}:bridge`, 'bridge', 1, -W - 2, W + 2, y, y + 3, bz, bz + 5, true));
    break;
  }
  w.towers[side].push({ z0, z1, h });
}

function frame(w, sd, id, z0, z1) {
  const { rng, structures: out } = w;
  const depth = range(rng, L.frameDepth), h = range(rng, L.frameH), t = L.beam;
  let n = 0;
  for (const a of [W, W + depth - t]) for (const z of [z0, z1 - t]) out.push(box(w, `${id}:post${n++}`, 'frame', sd, a, a + t, 0, h, z, z + t, false));
  n = 0;
  for (const a of [W, W + depth - t]) out.push(box(w, `${id}:beam${n++}`, 'frame', sd, a, a + t, h - t, h, z0, z1, false));
  for (const z of [z0, z1 - t]) out.push(box(w, `${id}:beam${n++}`, 'frame', sd, W, W + depth, h - t, h, z, z + t, false));
}

function crane(w, sd, id, z0, z1) {
  const { rng, structures: out } = w;
  const zc = (z0 + z1) / 2, H = range(rng, L.craneH);
  out.push(box(w, `${id}:mast`, 'crane', sd, W + 3, W + 6, 0, H, zc - 1.5, zc + 1.5, true));
  out.push(box(w, `${id}:jib`, 'crane', sd, W - range(rng, L.craneReach), W + 14, H, H + 3, zc - 1.5, zc + 1.5, true));
}

// One lot on the side with the lower frontier. The guarantee: a lot that is not a sure anchor is only placed
// if a sure anchor can still start within maxGap of coverEnd afterwards; otherwise it becomes a tower, pulled
// forward so it starts by coverEnd + maxGap. Lots are placed at the lower frontier, so this holds by induction;
// a lot never runs past its side's end, where the next corner tower (a sure anchor) starts.
function placeLot(w, side) {
  const { rng } = w;
  const other = w.nextZ[side === 'L' ? 'R' : 'L'];
  const f = w.nextZ[side], end = w.end[side];
  const d = difficulty(w.d0 + Math.abs(f));
  if (f >= w.section.end) {
    const mode = rng() < d.oneSide ? (rng() < 0.5 ? 'L' : 'R') : 'both';
    w.section = { end: f + range(rng, L.sectionLen), mode };
  }
  const built = w.section.mode === 'both' || w.section.mode === side;
  let kind = pick(rng, built ? d.weights : L.offWeights);
  let z0 = f + range(rng, d.alley);
  let len = lotLen(rng, kind);
  if (kind !== 'tower' && Math.min(z0 + len, other, end) - w.coverEnd > d.maxGap) {
    kind = 'tower';
    len = lotLen(rng, kind);
  }
  if (kind === 'tower') z0 = Math.min(z0, Math.max(f, w.coverEnd + d.maxGap));
  const z1 = Math.min(z0 + len, end), sd = side === 'L' ? -1 : 1, id = `${side}${w.nextId++}`;
  w.nextZ[side] = Math.max(z1, Math.min(z0, end));
  if (z1 - z0 < (kind === 'tower' ? 0.5 : kind === 'crane' ? L.craneLot : 6)) return; // no room left before the corner
  if (kind === 'tower') tower(w, side, sd, id, z0, z1, d);
  else if (kind === 'low') w.structures.push(...building(lotOf(w, id, sd, range(rng, L.depth), z0, z1), range(rng, L.lowH), rng, d));
  else if (kind === 'frame') frame(w, sd, id, z0, z1);
  else if (kind === 'crane') crane(w, sd, id, z0, z1);
}

// The lots of segment m of street (axis, line), without its corner towers. Ids start with e.g. 'Z0_3' (col 0, rows 3..4).
export function buildSegment(seed, axis, line, m) {
  const ck = centreKind(axis), xk = crossKind(axis);
  const c = lineAt(seed, ck, line), a = lineAt(seed, xk, m) + W, b = lineAt(seed, xk, m + 1) - W;
  const lat = axis === 'z' ? 'x' : 'z';
  const ext = (k, sd, sv) => { const t = cornerOf(seed, axis, line, k, sd, sv); return t.max[axis] - t.min[axis]; };
  const start = { L: a + ext(m, -1, 1), R: a + ext(m, 1, 1) };
  const w = {
    rng: makeRng(Math.floor(hashN(seed, 4, axis === 'z' ? 0 : 1, line, m) * 4294967296)),
    structures: [], axis, lat, c, d0: Math.abs(c), prefix: `${axis.toUpperCase()}${line}_${m}`,
    nextZ: { ...start }, end: { L: b - ext(m + 1, -1, -1), R: b - ext(m + 1, 1, -1) },
    coverEnd: Math.max(start.L, start.R), // the corner towers cover up to here
    section: { end: -Infinity, mode: 'both' }, towers: { L: [], R: [] }, nextId: 0,
  };
  for (;;) {
    const l = w.nextZ.L < w.end.L, r = w.nextZ.R < w.end.R;
    if (!l && !r) break;
    placeLot(w, l && (!r || w.nextZ.L <= w.nextZ.R) ? 'L' : 'R');
  }
  return w.structures;
}

// The four corner towers at the two ends of segment m of street (axis, line).
export const segmentCorners = (seed, axis, line, m) => [
  cornerOf(seed, axis, line, m, -1, 1), cornerOf(seed, axis, line, m, 1, 1),
  cornerOf(seed, axis, line, m + 1, -1, -1), cornerOf(seed, axis, line, m + 1, 1, -1),
];

// ---- the live world: only the segments near the hero ----
// fixed: a hand-built course (tests) that updateWorld leaves alone.
export const createWorld = (seed = 1) => ({ seed, structures: [], cache: new Map(), key: '', fixed: false });

// The segments to keep for a hero at pos on street: [axis, line, m] for the current street from behindDistance
// behind to viewDistance ahead, and both cross-street segments at each intersection from behindDistance behind up to
// crossIntersections ahead (so the corner towers and the first block of either turn exist before he gets there).
export function neededSegments(seed, pos, street) {
  const { axis, lat, line, dir } = street, xk = crossKind(axis), s = pos[axis];
  const lo = s - (dir > 0 ? CFG.behindDistance : CFG.viewDistance), hi = s + (dir > 0 ? CFG.viewDistance : CFG.behindDistance);
  const out = [];
  const m0 = lineIndex(seed, xk, lo), m1 = lineIndex(seed, xk, hi);
  for (let m = m0; m <= m1; m++) out.push([axis, line, m]);
  let ahead = 0;
  for (let k = dir > 0 ? m0 : m1 + 1; dir > 0 ? k <= m1 + 1 : k >= m0; k += dir) {
    const rel = (lineAt(seed, xk, k) - s) * dir;
    if (rel < -CFG.behindDistance - W || rel > CFG.viewDistance) continue;
    if (rel > W && ++ahead > CFG.crossIntersections) break;
    out.push([lat, k, line - 1], [lat, k, line]);
  }
  return out;
}

// Build the segments near the hero (cached while needed) and drop the rest. w.structures is a new array only when
// the set changes.
export function updateWorld(w, pos, street) {
  if (w.fixed) return;
  const segs = neededSegments(w.seed, pos, street);
  const key = segs.map((t) => t.join(',')).join(';');
  if (key === w.key) return;
  w.key = key;
  const live = new Map(), list = new Map();
  for (const [axis, line, m] of segs) {
    const k = `${axis}${line}_${m}`;
    const lots = w.cache.get(k) ?? buildSegment(w.seed, axis, line, m);
    live.set(k, lots);
    for (const s of [...segmentCorners(w.seed, axis, line, m), ...lots]) list.set(s.id, s);
  }
  w.cache = live;
  w.structures = [...list.values()];
}
