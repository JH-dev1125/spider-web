// Pure per-frame game update shared by main.js and the headless bot test. No window/document.
//
// Renderer contract — the view main.js passes to renderer.render(view, dt) every frame:
//   { player, structures, web, missLine, pose, t, shake }
//   player     { pos:{x,y,z}, vel:{x,y,z}, ropes, anchor:{x,y,z}|null, ropeLen, alive } — pos/vel are copied from the
//              physics body each frame (plus swingPhase, ropeMin: game-internal, ignore).
//              ropes [{ slot:'L'|'R', anchor:{x,y,z}, len, tension }] — every held web (one per hand, at most two);
//              tension in newtons from the solver. anchor / ropeLen = the most recently attached rope (single-rope readers).
//   structures [{ id:string, kind, min:{x,y,z}, max:{x,y,z}, attach:boolean }] — axis-aligned boxes in world metres
//              (x right, y up, z forward, street at y = 0). kind: 'tower' (solid block) | 'setback' (stepped upper
//              block on a tower) | 'frame' (one post/beam of a hollow frame, attach false) | 'crane' (mast or jib) |
//              'bridge' (skybridge between towers) | 'ledge' (small protrusion). id is stable for the box's lifetime;
//              boxes of one composite share a prefix before ':' ('R12:base', 'R12:setback', 'L7:post0').
//              Boxes are added ahead (CFG.viewDistance) and removed behind (CFG.behindDistance).
//   web        { from, to, dist, travelled, hit, slot } | null — the most recently fired web in flight (from = the hand,
//              to = target point). g.webs {L, R} holds both slots' flights.
//   missLine   { to, age } | null — a web that hit nothing holdable, shown briefly.
//              wall: the face's outward normal x while wall-running (-1 wall on the right, +1 on the left), else 0.
//   pose       'swing' | 'glide' | 'roll' | 'tuck' | 'fall' | 'wallrun' | 'run' (roof) | 'walljump';  t: seconds;  shake: camera shake amount.
import { CFG } from './config.js';
import { makeRng, createWorld, updateWorld } from './world.js';
import { createPlayer, createPhysics, syncStructures, raycast, attach, release, stepPhysics, setZip } from './player.js';
import { aimVector } from './web.js';

export const pickTrickPose = (rng) => {
  const t = CFG.character.tricks;
  return t[Math.min(t.length - 1, Math.floor(rng() * t.length))];
};

export function createGame(seed) {
  const player = createPlayer();
  const g = {
    rng: makeRng(seed),
    world: createWorld(seed),
    player,
    phys: createPhysics(player),
    elapsed: 0,
    pose: 'glide',
    trickSec: 0,
    missLine: null,
    web: null, // the most recent web in flight (for the renderer)
    webs: { L: null, R: null }, // web in flight per hand slot: {from, to, dist, travelled, hit, slot, seq}
    cSlot: 'R', // the slot the last overhead ('C') press went to, so its release finds it
    shots: 0, slotSeq: { L: 0, R: 0 }, // presses so far; the press number each slot last fired on
    shake: 0,
  };
  updateWorld(g.world, player.pos.z);
  syncStructures(g.phys, g.world.structures);
  return g;
}

const hand = (p) => ({ x: p.pos.x, y: p.pos.y + CFG.render.playerHand, z: p.pos.z });

// Where a web pressed now would go: {from, to, hit} (hit = it lands on something holdable).
export function aim(g, side, level) {
  const dir = aimVector(side, level, g.player.pos.x);
  const from = hand(g.player);
  const r = raycast(g.phys, from, dir, CFG.webRange);
  const to = r ? r.point : { x: from.x + dir.x * CFG.webRange, y: from.y + dir.y * CFG.webRange, z: from.z + dir.z * CFG.webRange };
  return { from, to, hit: !!r?.attach };
}

const SLOTS = ['L', 'R'];
const busy = (g, s) => !!(g.webs[s] || g.phys.ropes.slots[s]);
// The hand slot a side fires from: Q/A/Z = 'L', E/D/C = 'R'; overhead 'C' (W) = a free hand, else the one pressed longer ago.
function slotFor(g, side) {
  if (side !== 'C') return side;
  return (g.cSlot = SLOTS.find((s) => !busy(g, s)) ?? (g.slotSeq.L <= g.slotSeq.R ? 'L' : 'R'));
}

// A press launches a web from the hand into its slot. The target is cast now (structures are static); it lands
// after dist / webSpeed seconds. That slot's held rope stays until the new web lands; the other slot is untouched.
function fire(g, s) {
  const slot = slotFor(g, s.side);
  const { from, to, hit } = aim(g, s.side, s.level);
  g.webs[slot] = { from, to, dist: Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z), travelled: 0, hit, slot, seq: ++g.shots };
  g.slotSeq[slot] = g.shots;
}

// Advance each web in flight; on arrival attach its slot (key still held, or it would have been cancelled) or show a miss.
function flyWebs(g, dt) {
  for (const slot of SLOTS) {
    const w = g.webs[slot];
    if (!w) continue;
    w.from = hand(g.player);
    w.travelled = Math.min(w.dist, w.travelled + CFG.webSpeed * dt);
    if (w.travelled < w.dist) continue;
    g.webs[slot] = null;
    if (w.hit && attach(g.phys, g.player, w.to, slot)) g.missLine = null;
    else g.missLine = { to: w.to, age: 0 };
  }
}

const latestWeb = (g) => SLOTS.map((s) => g.webs[s]).filter(Boolean).reduce((a, w) => (!a || w.seq > a.seq ? w : a), null);

// actions: [{type: 'press', side, level} | {type: 'release', side?} | {type: 'zip'} | {type: 'zipEnd'}]. A press launches
// a web (fixed range) into its hand slot; a release lets go of that side's rope and cancels its web still in flight
// (no side = every rope: blur, death); zip pulls hard along the held ropes (their summed direction) until zipEnd,
// a release of the last rope, or passing the anchors (then they let go by themselves); without a rope zip does nothing.
// Returns events ('bottom', 'released', 'zipped', 'bounce', 'wallrun', 'walljump', 'dead').
export function stepGame(g, dt, actions) {
  dt = Math.min(dt, CFG.maxDt);
  const p = g.player;
  const events = [];
  g.shake *= Math.exp(-CFG.render.shakeDecay * dt);
  if (p.alive) {
    g.elapsed += dt;
    updateWorld(g.world, p.pos.z);
    syncStructures(g.phys, g.world.structures);
    for (const a of actions) {
      if (a.type === 'press') fire(g, a);
      else if (a.type === 'release') {
        const slot = a.side == null ? null : a.side === 'C' ? g.cSlot : a.side;
        for (const s of SLOTS) if (slot === null || s === slot) g.webs[s] = null;
        if (release(g.phys, p, slot)) events.push('released');
      } else if (a.type === 'zip') setZip(g.phys, true);
      else if (a.type === 'zipEnd') setZip(g.phys, false);
    }
    events.push(...stepPhysics(g.phys, p, dt));
    if (p.alive) flyWebs(g, dt);
    else g.webs = { L: null, R: null };
    g.web = latestWeb(g);
    if (events.includes('bottom')) g.shake = CFG.render.shakePeak;
    if (events.includes('bounce')) g.shake = Math.max(g.shake, CFG.render.bounceShake);
    if (events.includes('released')) { g.pose = pickTrickPose(g.rng); g.trickSec = CFG.trickSec; }
    if (events.includes('walljump')) { g.pose = 'walljump'; g.trickSec = CFG.trickSec; }
  } else { g.web = null; g.webs = { L: null, R: null }; }
  g.trickSec = Math.max(0, g.trickSec - dt);
  if (!p.alive) g.pose = 'fall';
  else if (p.wall) g.pose = 'wallrun';
  else if (p.roof) g.pose = 'run';
  else if (p.anchor) g.pose = 'swing';
  else if (g.trickSec === 0) g.pose = 'glide';
  if (g.missLine && (g.missLine.age += dt) > CFG.missShowSec) g.missLine = null;
  return events;
}

// Autopilot: while unattached, wait CFG.botWaitSec, then try all six aims and press the holdable one whose
// swing bottom (anchor height - reeled rope) is highest; hold through the web's flight and release
// once the swing has passed its bottom and climbs at CFG.botReleaseClimb (vel.y / speed), or stalls.
// With nothing holdable it keeps looking every frame. zip: also zip each rope anchored above and ahead (?autozip).
// dual (?dualrope): also press the best aim on the other side, holding both ropes; the release lets go of both.
export function createBot({ zip = false, dual = false } = {}) {
  let wait = 0, held = false, zipped = null;
  return (g, dt) => {
    const p = g.player;
    dt = Math.min(dt, CFG.maxDt);
    if (!p.alive) return [];
    if (zip && held && p.anchor && zipped !== p.anchor && p.anchor.y > p.pos.y + 5 && p.anchor.z > p.pos.z + 10) { zipped = p.anchor; return [{ type: 'zip' }]; }
    if (held && p.anchor) {
      const v = p.vel, speed = Math.hypot(v.x, v.y, v.z);
      if (p.swingPhase !== 'ascending' || (v.y < CFG.botReleaseClimb * speed && speed > CFG.botStallSpeed)) return [];
      held = false; wait = 0;
      return [{ type: 'release' }];
    }
    if (held && g.web) return []; // web still flying
    if (held) { held = false; wait = 0; return [{ type: 'release' }]; } // missed: let go, retry
    if ((wait += dt) < CFG.botWaitSec) return [];
    const best = {}; // per side: {score, press}
    for (const side of ['L', 'R']) {
      for (const level of ['hi', 'mid', 'lo']) {
        const a = aim(g, side, level);
        if (!a.hit) continue;
        const len = Math.hypot(a.to.x - p.pos.x, a.to.y - p.pos.y, a.to.z - p.pos.z);
        // swing bottom after reeling, minus a penalty for already drifting toward that wall
        const score = a.to.y - len * CFG.reelMinFactor - 3 * Math.max(0, Math.sign(a.to.x) * p.vel.x);
        if (len >= CFG.botRopeMin && len <= CFG.botRopeMax && score > (best[side]?.score ?? -Infinity)) best[side] = { score, press: { type: 'press', side, level } };
      }
    }
    const picks = Object.values(best).sort((a, b) => b.score - a.score).slice(0, dual ? 2 : 1);
    if (!picks.length) return [];
    held = true;
    return picks.reverse().map((b) => b.press); // the best one last: it is the most recent rope
  };
}
