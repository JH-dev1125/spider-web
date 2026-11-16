// Pure per-frame game update shared by main.js and the headless bot test. No window/document.
//
// Renderer contract — the view main.js passes to renderer.render(view, dt) every frame:
//   { player, structures, web, missLine, pose, t, shake, street, distance }
//   player     { ragdoll:{part:Body}, webSide, wall, roof, pos:{x,y,z}, vel:{x,y,z}, anchor:{x,y,z}|null, ropePoints:[{x,y,z,n}], ropeLen, alive } — pos/vel are copied from the
//              pelvis each frame; ragdoll body transforms are read-only to the renderer (plus swingPhase, ropeMin: game-internal, ignore).
//              anchor = where the web stuck. ropePoints = the bends of a rope wrapped around structure edges,
//              anchor end first: the rope runs hand -> ropePoints[last] -> ... -> ropePoints[0] -> anchor ([] when
//              straight). The hero swings on ropePoints[last] (or the anchor); ropeLen is that free length.
//   street     { axis:'z'|'x' (travel axis), lat (the other axis), dir:+1|-1, line (grid index), centre } — the
//              street the hero travels; it switches inside an intersection once his horizontal velocity is more
//              than turnShare along the cross street. Aims, the camera, wall and roof runs and the score follow it.
//              Local frame helpers (right of travel, ahead) are in street.js.
//   distance   metres along the streets: the integral of the velocity along the current street direction.
//   structures [{ id:string, kind, min:{x,y,z}, max:{x,y,z}, attach:boolean }] — axis-aligned boxes in world metres
//              (x right, y up, z forward, street at y = 0). kind: 'tower' (solid block) | 'setback' (stepped upper
//              block on a tower) | 'frame' (one post/beam of a hollow frame, attach false) | 'crane' (mast or jib) |
//              'bridge' (skybridge between towers) | 'ledge' (small protrusion). id is stable for the box's lifetime;
//              boxes of one composite share a prefix before ':' ('R12:base', 'R12:setback', 'L7:post0').
//              Ids: 'K<col>_<row>_<q>:base' (a block-corner tower), '<X|Z><line>_<m><L|R><n>:part' (a lot on segment m
//              of a street). face ('+x'|'-x'|'+z'|'-z', towers only): the outward normal of the face on the street.
//              The city is a grid (world.js); only the current street (behindDistance back, viewDistance ahead) and
//              the cross streets at the next intersections exist.
//   web        { from, to, dist, travelled, hit } | null — a web in flight (from = the hand, to = target point).
//   missLine   { to, age } | null — a web that hit nothing holdable, or a rope that snapped, shown briefly.
//              wall: while wall-running, the face's outward normal along the street's lat axis (world sign: on the
//              start street -1 = wall on the right, +1 on the left), else 0.
//   pose       'swing' | 'glide' | 'roll' | 'tuck' | 'fall' | 'wallrun' | 'run' (roof) | 'walljump';  t: seconds;  shake: camera shake amount.
import { CFG } from './config.js';
import { makeRng, createWorld, updateWorld, clampToStreets, corridorAt, lineAt, lineIndex, centreKind,
  crossKind, cornerOf } from './world.js';
import { createPlayer, createPhysics, syncStructures, raycast, attach, release, stepPhysics, setZip, isTurnAnchor } from './player.js';
import { aimVector } from './web.js';
import { surfaceNormal } from './render-math.js';
import { makeStreet, heading, right, toLocal, toLocalVec, toWorldVec } from './street.js';

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
    web: null, // web in flight: {from, to, dist, travelled, hit}
    shake: 0,
    street: makeStreet('z', 0, 1, 0),
    distance: 0,
  };
  g.phys.street = g.street;
  g.phys.bound = (pos, vel) => !g.world.fixed && clampToStreets(seed, pos, vel);
  updateWorld(g.world, player.pos, g.street);
  syncStructures(g.phys, g.world.structures);
  return g;
}

const hand = (p, side = p.webSide) => {
  const v = p.ragdoll?.['hand' + side]?.position;
  return v ? { x: v.x, y: v.y, z: v.z } : { ...p.pos };
};

// How far ahead webs meet the street faces: aimAhead, unless that point falls in an intersection; then just past it, on
// the far corner tower's street face (not into the gap, onto the corner's face that looks back at him).
function aimAhead(g) {
  if (g.world.fixed) return CFG.aimAhead;
  const st = g.street, seed = g.world.seed, xk = crossKind(st.axis), a = g.player.pos[st.axis];
  const t = a + st.dir * CFG.aimAhead, k = lineIndex(seed, xk, t), W = CFG.corridorHalfWidth;
  const line = [k, k + 1].map((i) => lineAt(seed, xk, i)).find((v) => Math.abs(t - v) < W + 2);
  return line === undefined ? CFG.aimAhead : (line - a) * st.dir + W + CFG.aimPastCross;
}

// Where a web pressed now would go:{from, to, hit} (hit = it lands on something holdable).
// Sides and the aim ahead are relative to the street heading (left / right of travel, ahead along it).
export function aim(g, side, level) {
  const dir = toWorldVec(g.street, aimVector(side, level, toLocal(g.street, g.player.pos).x, aimAhead(g)));
  const from = hand(g.player, side);
  const r = raycast(g.phys, from, dir, CFG.webRange);
  const to = r ? r.point : { x: from.x + dir.x * CFG.webRange, y: from.y + dir.y * CFG.webRange, z: from.z + dir.z * CFG.webRange };
  return { from, to, hit: !!r?.attach, id: r?.id ?? null };
}

// A press launches a web from the hand. The target is cast now (structures are static); it lands after
// dist / webSpeed seconds. A held rope stays until the new web lands (last pressed wins on arrival).
function fire(g, s) {
  const { from, to, hit, id } = aim(g, s.side, s.level);
  g.web = { side: s.side, from, to, dist: Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z), travelled: 0, hit, id };
}

// Advance the web in flight; on arrival attach (key still held, or it would have been cancelled) or show a miss.
function flyWeb(g, dt) {
  const w = g.web;
  w.from = hand(g.player, w.side);
  w.travelled = Math.min(w.dist, w.travelled + CFG.webSpeed * dt);
  if (w.travelled < w.dist) return;
  g.web = null;
  if (w.hit && attach(g.phys, g.player, w.to, w.side, w.id)) { g.missLine = null; return; }
  g.missLine = { to: w.to, age: 0 };
}

// actions: [{type: 'press', side, level} | {type: 'release'} | {type: 'zip'} | {type: 'zipEnd'}]. A press launches a web
// (fixed range); a release lets go of the rope and cancels a web still in flight; zip pulls hard along the attached rope
// until zipEnd, a release, or passing the anchor (then the rope lets go by itself); without a rope zip does nothing.
// Returns events ('bottom', 'released', 'zipped', 'bounce', 'wallrun', 'walljump', 'snapped', 'turned', 'dead').
export function stepGame(g, dt, actions) {
  dt = Math.min(dt, CFG.maxDt);
  const p = g.player;
  const events = [];
  g.shake *= Math.exp(-CFG.render.shakeDecay * dt);
  if (p.alive) {
    g.elapsed += dt;
    updateWorld(g.world, p.pos, g.street);
    syncStructures(g.phys, g.world.structures);
    for (const a of actions) {
      if (a.type === 'press') fire(g, a);
      else if (a.type === 'release') {
        g.web = null;
        if (release(g.phys, p)) events.push('released');
      } else if (a.type === 'zip') setZip(g.phys, true);
      else if (a.type === 'zipEnd') setZip(g.phys, false);
    }
    p.mode = g.pose;
    const before = { ...p.pos }, pivot = p.ropePoints.at(-1) ?? p.anchor;
    events.push(...stepPhysics(g.phys, p, dt));
    const h = heading(g.street);
    g.distance += (p.pos.x - before.x) * h.x + (p.pos.z - before.z) * h.z;
    if (p.alive && updateStreet(g)) events.push('turned');
    if (events.includes('snapped')) g.missLine = { to: { ...pivot }, age: 0 };
    if (g.web && p.alive) flyWeb(g, dt);
    if (events.includes('bottom')) g.shake = CFG.render.shakePeak;
    if (events.includes('bounce')) g.shake = Math.max(g.shake, CFG.render.bounceShake);
    if (events.includes('released')) { g.pose = pickTrickPose(g.rng); g.trickSec = CFG.trickSec; }
    if (events.includes('walljump')) { g.pose = 'walljump'; g.trickSec = CFG.trickSec; }
  } else { g.web = null; stepPhysics(g.phys, p, dt); }
  g.trickSec = Math.max(0, g.trickSec - dt);
  if (!p.alive) g.pose = 'fall';
  else if (p.wall) g.pose = 'wallrun';
  else if (p.roof) g.pose = 'run';
  else if (p.anchor) g.pose = 'swing';
  else if (g.trickSec === 0) g.pose = 'glide';
  if (g.missLine && (g.missLine.age += dt) > CFG.missShowSec) g.missLine = null;
  return events;
}

// Switch to the cross street when he is in its corridor (turnInset inside it) with the horizontal velocity more than
// turnShare along it (and more than along his own street): swinging round a corner. Also when he has left his own
// corridor sideways into it (the block bounds only keep him on some street). Returns true on a switch.
function updateStreet(g) {
  const p = g.player, st = g.street, seed = g.world.seed, v = p.vel;
  if (g.world.fixed) return false;
  const line = corridorAt(seed, crossKind(st.axis), p.pos[st.axis], -CFG.turnInset);
  if (line === null) return false;
  const vc = Math.abs(v[st.lat]), off = p.pos[st.lat] - st.centre;
  const turned = vc > CFG.turnShare * Math.hypot(v.x, v.z) && vc > Math.abs(v[st.axis]);
  if (!turned && Math.abs(off) <= CFG.corridorHalfWidth + CFG.streetMargin) return false;
  const axis = st.lat;
  g.street = g.phys.street = makeStreet(axis, line, (turned ? Math.sign(v[axis]) : 0) || Math.sign(off) || 1,
    lineAt(seed, centreKind(axis), line));
  return true;
}

// The corner tower on the near side of the next intersection ahead, on the turn side ('L' | 'R' of travel), and how
// far ahead that intersection's centre is: { tower, ahead } (null on a hand-built course).
export function nextCorner(g, side) {
  if (g.world.fixed) return null;
  const st = g.street, seed = g.world.seed, xk = crossKind(st.axis), s = g.player.pos[st.axis];
  let k = lineIndex(seed, xk, s) + (st.dir > 0 ? 1 : 0);
  if ((lineAt(seed, xk, k) - s) * st.dir < -CFG.corridorHalfWidth) k += st.dir; // already through this one
  const r = right(st)[st.lat], sd = side === 'R' ? Math.sign(r) : -Math.sign(r);
  return { tower: cornerOf(seed, st.axis, st.line, k, sd, -st.dir), ahead: (lineAt(seed, xk, k) - s) * st.dir };
}

// A point on a face that looks back down the street (a cross-street corner seen across an intersection): swinging
// on it carries the hero into that face.
const facesBack = (g, q) => {
  const n = surfaceNormal(q, g.world.structures), h = heading(g.street);
  return n.x * h.x + n.z * h.z < -0.5;
};

// Autopilot: while unattached, wait CFG.botWaitSec, then try all six aims and press the holdable one whose
// swing bottom (anchor height - reeled rope) is highest; hold through the web's flight and release
// once the swing has passed its bottom and climbs at CFG.botReleaseClimb (vel.y / speed), or stalls.
// With nothing holdable it keeps looking every frame. zip: also zip each rope anchored above and ahead (?autozip).
// turn ('L' | 'R' | 'alt', ?autoturn): at each intersection web the near corner tower on that side, hold the swing
// round the corner until the street switches (or 3 s), then let go and carry on down the cross street.
const TURN_LEVELS = ['lo', 'mid'];
export function createBot({ zip = false, turn = null } = {}) {
  let wait = 0, held = false, zipped = null, turning = null, turns = 0;
  const inside = (q, s) => ['x', 'y', 'z'].every((k) => q[k] >= s.min[k] - 0.05 && q[k] <= s.max[k] + 0.05);
  return (g, dt) => {
    const p = g.player;
    dt = Math.min(dt, CFG.maxDt);
    if (!p.alive) return [];
    if (turning) {
      if (held && g.web) return [];
      turning.sec += dt;
      if (p.anchor && g.street === turning.street && turning.sec < 3) return [];
      if (g.street !== turning.street) turns++;
      turning = null; held = false; wait = 0;
      return p.anchor ? [{ type: 'release' }] : [];
    }
    if (turn && !g.web) { // a press while attached replaces the rope when it lands
      const side = turn === 'alt' ? (turns % 2 ? 'L' : 'R') : turn, c = nextCorner(g, side);
      const edge = c && c.ahead - CFG.corridorHalfWidth; // how far ahead the corner's edge is
      if (c && edge > 0 && edge < CFG.aimAhead + 20 && p.pos.y > CFG.botTurnMinY && p.vel.y > -CFG.botTurnMaxSink) {
        for (const level of TURN_LEVELS) {
          const a = aim(g, side, level), short = edge - (toLocal(g.street, a.to).z - toLocal(g.street, p.pos).z);
          // anchored within turnReach of the edge, he passes beside it at the edge and circles round it
          if (a.hit && inside(a.to, c.tower) && short >= 0 && short <= CFG.turnReach) {
            turning = { street: g.street, sec: 0 }; held = true;
            return [{ type: 'press', side, level }];
          }
        }
      }
    }
    if (zip && held && p.anchor && zipped !== p.anchor && p.anchor.y > p.pos.y + 5 && p.anchor.z > p.pos.z + 10) { zipped = p.anchor; return [{ type: 'zip' }]; }
    if (p.wall) return []; // keep the web through the stance; foot-induced velocity is not a swing bottom
    if (held && p.anchor) {
      const v = p.vel, speed = Math.hypot(v.x, v.y, v.z);
      if (p.swingPhase !== 'ascending' || (v.y < CFG.botReleaseClimb * speed && speed > CFG.botStallSpeed)) return [];
      held = false; wait = 0;
      return [{ type: 'release' }];
    }
    if (held && g.web) return []; // web still flying
    if (held) { held = false; wait = 0; return [{ type: 'release' }]; } // missed: let go, retry
    if ((wait += dt) < CFG.botWaitSec) return [];
    let best = null, bestScore = -Infinity;
    for (const side of ['L', 'R']) {
      for (const level of ['hi', 'mid', 'lo']) {
        const a = aim(g, side, level);
        if (!a.hit || facesBack(g, a.to) || isTurnAnchor(g.phys, a.to, a.id)) continue; // (a turn is the turning bot's job)
        const len = Math.hypot(a.to.x - p.pos.x, a.to.y - p.pos.y, a.to.z - p.pos.z);
        // swing bottom after reeling, minus a penalty for already drifting toward that wall
        const lat = toLocal(g.street, a.to).x, latV = toLocalVec(g.street, p.vel).x;
        const score = a.to.y - len * CFG.reelMinFactor - 3 * Math.max(0, Math.sign(lat) * latV) + (Math.sign(lat) === Math.sign(toLocal(g.street, p.pos).x) ? 3 : 0);
        if (len >= CFG.botRopeMin && len <= CFG.botRopeMax && score > bestScore) { bestScore = score; best = { type: 'press', side, level }; }
      }
    }
    if (!best) return [];
    held = true;
    return [best];
  };
}
