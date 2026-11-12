// Pure per-frame game update shared by main.js and the headless bot test. No window/document.
import { CFG } from './config.js';
import { makeRng, difficulty, createWorld, updateWorld } from './world.js';
import { createPlayer, attach, release, stepPlayer } from './player.js';
import { aimVector, castWeb } from './web.js';

export const pickTrickPose = (rng) => {
  const t = CFG.character.tricks;
  return t[Math.min(t.length - 1, Math.floor(rng() * t.length))];
};

export function createGame(seed) {
  const g = {
    rng: makeRng(seed),
    world: createWorld(),
    player: createPlayer(),
    elapsed: 0,
    pose: 'glide',
    trickSec: 0,
    missLine: null,
    web: null, // web in flight: {from, to, dist, travelled, hit}
    shake: 0,
  };
  updateWorld(g.world, g.player.pos.z, 0, g.rng);
  return g;
}

const hand = (p) => ({ x: p.pos.x, y: p.pos.y + CFG.render.playerHand, z: p.pos.z });

// A press launches a web from the hand. The target is cast now (buildings are static); it lands after
// dist / webSpeed seconds. A held rope stays until the new web lands (last pressed wins on arrival).
function fire(g, s) {
  const dir = aimVector(s.side, s.level);
  const from = hand(g.player);
  const hit = castWeb(from, dir, CFG.webRange, g.world.buildings);
  const to = hit || { x: from.x + dir.x * CFG.webRange, y: from.y + dir.y * CFG.webRange, z: from.z + dir.z * CFG.webRange };
  g.web = { from, to, dist: Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z), travelled: 0, hit: !!hit };
}

// Advance the web in flight; on arrival attach (key still held, or it would have been cancelled) or show a miss.
function flyWeb(g, dt) {
  const w = g.web;
  w.from = hand(g.player);
  w.travelled = Math.min(w.dist, w.travelled + CFG.webSpeed * dt);
  if (w.travelled < w.dist) return;
  g.web = null;
  if (w.hit && attach(g.player, w.to)) { g.missLine = null; return; }
  g.missLine = { to: w.to, age: 0 };
}

// After death stepPlayer is inert: plain gravity, and the body stops dead once it is on the street.
function fall(p, dt) {
  const v = p.vel;
  v.y -= CFG.gravity * dt;
  p.pos.x += v.x * dt;
  p.pos.y = Math.max(0, p.pos.y + v.y * dt);
  p.pos.z += v.z * dt;
  if (p.pos.y === 0) v.x = v.y = v.z = 0;
}

// actions: [{type: 'press', side, level} | {type: 'release'}]. A press launches a web (fixed range);
// a release lets go of the rope and cancels a web still in flight. Returns events ('bottom', 'released', 'bounce', 'dead').
export function stepGame(g, dt, actions) {
  dt = Math.min(dt, CFG.maxDt);
  const p = g.player;
  let events = [];
  g.shake *= Math.exp(-CFG.render.shakeDecay * dt);
  if (p.alive) {
    g.elapsed += dt;
    const diff = difficulty(g.elapsed);
    updateWorld(g.world, p.pos.z, g.elapsed, g.rng);
    for (const a of actions) {
      if (a.type === 'press') fire(g, a);
      else if (a.type === 'release') {
        g.web = null;
        if (release(p)) events.push('released');
      }
    }
    events.push(...stepPlayer(p, dt, g.world.buildings, diff.speed));
    if (g.web && p.alive) flyWeb(g, dt);
    if (events.includes('bottom')) g.shake = CFG.render.shakePeak;
    if (events.includes('bounce')) g.shake = Math.max(g.shake, CFG.render.bounceShake);
    if (events.includes('released')) { g.pose = pickTrickPose(g.rng); g.trickSec = CFG.trickSec; }
  } else { fall(p, dt); g.web = null; }
  g.trickSec = Math.max(0, g.trickSec - dt);
  if (!p.alive) g.pose = 'fall';
  else if (p.anchor) g.pose = 'swing';
  else if (g.trickSec === 0) g.pose = 'glide';
  if (g.missLine && (g.missLine.age += dt) > CFG.missShowSec) g.missLine = null;
  return events;
}

// Simple autopilot: while unattached, wait CFG.botWaitSec then press 'hi' (alternating R/L) and hold
// through the web's flight; release CFG.botHoldAfterBottomSec after the swing bottom. A miss is let go and retried.
export function createBot() {
  let side = 'R';
  let wait = 0, after = 0, held = false;
  return (g, dt) => {
    const p = g.player;
    dt = Math.min(dt, CFG.maxDt);
    if (!p.alive) return [];
    if (held && p.anchor) {
      if (p.swingPhase !== 'ascending' || (after += dt) < CFG.botHoldAfterBottomSec) return [];
      held = false; wait = 0;
      return [{ type: 'release' }];
    }
    if (held && g.web) return []; // web still flying
    if (held) { held = false; wait = 0; return [{ type: 'release' }]; } // missed: let go, retry
    if ((wait += dt) < CFG.botWaitSec) return [];
    held = true; after = 0;
    const a = { type: 'press', side, level: 'hi' };
    side = side === 'R' ? 'L' : 'R';
    return [a];
  };
}
