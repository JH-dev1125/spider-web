// Building archetypes: one lot's footprint + height -> structure boxes (the renderer contract in game.js).
// Pure data, no three.js. world.js calls buildBuilding where it used to push a single tower block.
//
// Boxes carry the contract fields plus: arch (the archetype name), facing ('+x'|'-x'|'+z'|'-z': the street side
// of the footprint, which way signs and clock dials face), and for some kinds shape / light (render hints).
// Kinds added here: 'slab' (terrace floor/ceiling, attach), 'column' (terrace column, attach false), 'spire'
// (crowns, needles, masts, pinnacles), 'roof' (pitched roofs), 'clock', 'sign' (billboards, neon), 'balcony'
// (balconies, fire escapes), 'tank' (rooftop water tank). The face block stays kind 'tower' (sure anchors).
//
// Local frame: a = metres in from the street face (negative = proud of it, over the street), u = metres along
// the face, y up. Every archetype is written in (a, u, y) and mapped to world boxes by the footprint.

const FLOOR = 3;
// Terrace band (open floors in a tower): a floor slab, `open` metres of columns only, a ceiling slab. Reachability:
// a web at any height in the open band can go hi instead (+13 m at aimAhead), which lands on solid face because
// bands are at most `open` tall and have >= minSolid of solid face above them and between them.
export const BAND = { open: 6, slab: 0.8, minStart: 9, minSolid: 15 };
const COL = 1.6; // column side: > 3 physics steps at top speed, like the old frame beams, so nothing tunnels
const COL_STEP = 9;
export const TALL = ['deco', 'empire', 'clock', 'glass', 'gothic', 'pyramid', 'billboard', 'terrace'];
export const LOW = ['brownstone', 'walkup', 'warehouse'];
export const ARCHETYPES = [...TALL, ...LOW];
export const TALL_MIN = 36; // a lot at least this tall gets a tower archetype, lower ones a low-rise

// Footprint of a lot on a street corridor face: side sd (-1 left, +1 right), w = corridor half width.
export const streetLot = (id, sd, w, depth, z0, z1) => ({
  id, z0, z1, x0: sd > 0 ? w : -w - depth, x1: sd > 0 ? w + depth : -w, streetSide: sd > 0 ? '-x' : '+x',
});

function frameOf({ x0, x1, z0, z1, streetSide }) {
  const s = streetSide === 1 ? '+x' : streetSide === -1 ? '-x' : streetSide;
  const alongZ = s[1] === 'x';
  const across = (a0, a1) => (s === '+x' ? [x1 - a1, x1 - a0] : s === '-x' ? [x0 + a0, x0 + a1]
    : s === '+z' ? [z1 - a1, z1 - a0] : [z0 + a0, z0 + a1]);
  return {
    s,
    depth: alongZ ? x1 - x0 : z1 - z0,
    len: alongZ ? z1 - z0 : x1 - x0,
    box(a0, a1, u0, u1, y0, y1) {
      const [p0, p1] = across(a0, a1);
      const [q0, q1] = alongZ ? [z0 + u0, z0 + u1] : [x0 + u0, x0 + u1];
      return alongZ ? { min: { x: p0, y: y0, z: q0 }, max: { x: p1, y: y1, z: q1 } }
        : { min: { x: q0, y: y0, z: p0 }, max: { x: q1, y: y1, z: p1 } };
    },
  };
}

// Floor-slab bottoms of the terrace bands for a face block of height h (see BAND for the rules).
export function planBands(h, count, rng) {
  const out = [], span = BAND.open + 2 * BAND.slab;
  let y = BAND.minStart - BAND.slab + FLOOR * Math.floor(rng() * 4);
  while (out.length < count && y + span + BAND.minSolid <= h) {
    out.push(y);
    y += span + BAND.minSolid + FLOOR * Math.floor(rng() * 3);
  }
  return out;
}

export function buildBuilding(fp, height, rng, d = { p: 0.5 }) {
  const F = frameOf(fp), D = F.depth, Lf = F.len, p = d?.p ?? 0.5;
  const list = height >= TALL_MIN ? TALL : LOW;
  const arch = list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  const out = [];
  const put = (name, kind, attach, a0, a1, u0, u1, y0, y1, extra) => {
    out.push({ id: `${fp.id}:${name}`, kind, attach, arch, facing: F.s, ...F.box(a0, a1, u0, u1, y0, y1), ...extra });
  };
  const h = height, uc = Lf / 2, ac = D / 2;

  // face block, split by terrace bands
  // bands grow with difficulty; none in the easy start (p = 0), where every web should hold
  const bandN = p <= 0 ? 0 : arch === 'terrace' ? 1 + (rng() < p ? 1 : 0) + (rng() < p / 2 ? 1 : 0)
    : list === TALL && rng() < 0.35 * p ? 1 : 0;
  let y = 0, part = 0;
  const bands = planBands(h, bandN, rng);
  // nothing attachable is hung in front of an open band (signs, balconies)
  const clear = (y0, y1) => !bands.some((b) => y0 < b + BAND.open + 2 * BAND.slab + 1 && y1 > b - 1);
  bands.forEach((b, i) => {
    put(part ? `body${part}` : 'base', 'tower', true, 0, D, 0, Lf, y, b);
    const o0 = b + BAND.slab, o1 = o0 + BAND.open;
    put(`t${i}floor`, 'slab', true, 0, D, 0, Lf, b, o0);
    const m = Math.max(2, Math.ceil(Lf / COL_STEP));
    let k = 0;
    for (const a of [0, D - COL]) {
      for (let j = 0; j <= m; j++) {
        const u = (j * (Lf - COL)) / m;
        put(`t${i}c${k++}`, 'column', false, a, a + COL, u, u + COL, o0, o1);
      }
    }
    put(`t${i}ceil`, 'slab', true, 0, D, 0, Lf, o1, o1 + BAND.slab);
    y = o1 + BAND.slab; part++;
  });
  put(part ? `body${part}` : 'base', 'tower', true, 0, D, 0, Lf, y, h);

  // stacked tiers inset on all sides; returns the top {y, ins} (stops before a tier gets thinner than 6 m)
  const tiers = (steps) => {
    let top = h, ins = 0;
    steps.forEach(([inset, th], i) => {
      const n = ins + inset;
      if (D - 2 * n < 6 || Lf - 2 * n < 6) return;
      ins = n;
      put(`tier${i}`, 'setback', true, ins, D - ins, ins, Lf - ins, top, top + th);
      top += th;
    });
    return { top, ins };
  };
  const centred = (name, kind, size, y0, y1, extra) => put(name, kind, true, ac - size / 2, ac + size / 2, uc - size / 2, uc + size / 2, y0, y1, extra);
  const core = (ins) => Math.min(D, Lf) - 2 * ins;
  const fireEscape = (u0, from, to) => {
    let n = 0;
    for (let fy = from; fy + 1 < to && n < 8; fy += FLOOR) put(`fire${n++}`, 'balcony', true, -1.4, 0, u0, u0 + 5, fy, fy + 0.6, { shape: 'fire' });
  };
  const neon = (u0, y0, w, hh) => clear(y0, y0 + hh) && put('neon', 'sign', true, -0.4, 0, u0, u0 + w, y0, y0 + hh, { shape: 'neon' });
  const billboard = (yRoof) => {
    const w = Math.min(Lf - 4, 16);
    put('billboard', 'sign', true, 2, 3, uc - w / 2, uc + w / 2, yRoof + 3, yRoof + 9, { shape: 'billboard' });
  };

  switch (arch) {
    case 'deco': { // setbacks + a stainless crown of narrowing tiers and a needle
      const { top, ins } = tiers([[3, 9], [3, 7], [3, 6]]);
      let c = core(ins) * 0.8, cy = top;
      for (let i = 0; i < 3; i++) { const th = 6 - i; centred(`crown${i}`, 'spire', c, cy, cy + th, { shape: 'taper' }); cy += th; c *= 0.6; }
      centred('needle', 'spire', 1.2, cy, cy + 16, { shape: 'needle', light: true });
      break;
    }
    case 'empire': { // stepped tower, a slim top tier, an antenna mast
      const { top, ins } = tiers([[4, 15], [4, 9]]);
      const c = Math.max(4, core(ins) * 0.45);
      centred('crown', 'setback', c, top, top + 12);
      centred('mast', 'spire', 1.6, top + 12, top + 34, { shape: 'mast', light: true });
      break;
    }
    case 'clock': { // brick tower, a clock stage at the face with a lit dial, a pyramid roof
      const s = Math.min(12, D - 4, Lf - 4);
      put('stage', 'setback', true, 0, s, uc - s / 2, uc + s / 2, h, h + 14);
      const c = s * 0.75;
      put('clock', 'clock', true, -0.5, 0, uc - c / 2, uc + c / 2, h + 7 - c / 2, h + 7 + c / 2);
      put('roof', 'roof', true, 0, s, uc - s / 2, uc + s / 2, h + 14, h + 14 + s * 0.9, { shape: 'pyramid', light: true });
      break;
    }
    case 'glass': { // curtain wall, a mechanical penthouse, a mast; sometimes a big wall ad
      centred('mech', 'setback', Math.min(core(0) - 6, 14), h, h + 5);
      put('mast', 'spire', true, ac - 0.8, ac + 0.8, 2, 3.6, h, h + 14, { shape: 'mast', light: true });
      if (rng() < 0.5 && clear(h * 0.45, h * 0.45 + 10)) put('wallad', 'sign', true, -0.3, 0, uc - Math.min(9, uc - 2), uc + Math.min(9, uc - 2), h * 0.45, h * 0.45 + 10, { shape: 'wallad' });
      break;
    }
    case 'gothic': { // pinnacles at the corners, a tier, a central spire
      for (const [a, u, n] of [[0, 0, 0], [D - COL, 0, 1], [0, Lf - COL, 2], [D - COL, Lf - COL, 3]]) {
        put(`pin${n}`, 'spire', true, a, a + COL, u, u + COL, h, h + 7, { shape: 'needle' });
      }
      const { top, ins } = tiers([[3.5, 10]]);
      centred('spire', 'spire', Math.max(3, core(ins) * 0.4), top, top + 18, { shape: 'needle', light: true });
      break;
    }
    case 'pyramid': { // a tier capped by a pyramid roof with a beacon
      const { top, ins } = tiers([[2, 6]]);
      const c = core(ins);
      centred('roof', 'roof', c, top, top + c * 0.6, { shape: 'pyramid', light: true });
      break;
    }
    case 'billboard': { // rooftop billboard on its frame, a vertical neon sign on the face
      billboard(h);
      put('mech', 'setback', true, D - 8, D - 2, 2, 8, h, h + 4);
      neon(Math.max(1, uc * 0.3), h * 0.3, 3, 10);
      break;
    }
    case 'terrace': { // mixed use: terrace bands (above) and projecting balconies on solid floors
      let n = 0;
      for (let fy = 6; fy < h - 6 && n < 8; fy += FLOOR * 4) {
        if (!clear(fy, fy + 1.1)) continue;
        const u0 = 2 + ((n * 7) % Math.max(1, Lf - 8));
        put(`bal${n++}`, 'balcony', true, -1.4, 0, u0, u0 + 4, fy, fy + 1.1);
      }
      centred('mech', 'setback', Math.min(core(0) - 6, 10), h, h + 4);
      break;
    }
    case 'brownstone': { // brick walk-up with a fire escape, sometimes a neon bar sign
      fireEscape(Lf * 0.55, 6, h);
      if (rng() < 0.6) neon(2, 3.5, Math.min(6, Lf * 0.45 - 3), 1.5);
      break;
    }
    case 'walkup': { // a water tank on legs, a short fire escape
      const r = 2.2;
      put('tank', 'tank', true, ac - r, ac + r, uc - r, uc + r, h, h + 7.5);
      fireEscape(2, 6, Math.min(h, 16));
      break;
    }
    case 'warehouse': { // low brick shed with a rooftop billboard
      billboard(h);
      break;
    }
  }
  return out;
}
