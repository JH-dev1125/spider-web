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
    shake: 0,
  };
  updateWorld(g.world, g.player.pos.z, 0, g.rng);
  return g;
}

function fire(g, s) {
  const p = g.player;
  const dir = aimVector(s.side, s.level);
  const len = CFG.webRange;
  const o = { x: p.pos.x, y: p.pos.y + CFG.render.playerHand, z: p.pos.z }; // same origin as the aim preview
  const hit = castWeb(o, dir, len, g.world.buildings);
  if (hit && attach(p, hit)) { g.missLine = null; return; }
  g.missLine = { to: { x: o.x + dir.x * len, y: o.y + dir.y * len, z: o.z + dir.z * len }, age: 0 };
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

// actions: [{type: 'press', side, level} | {type: 'release'}]. A press fires a web at once (fixed range);
// a release lets go of the rope. Returns events ('bottom', 'released', 'bounce', 'dead').
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
      else if (a.type === 'release' && release(p)) events.push('released');
    }
    events.push(...stepPlayer(p, dt, g.world.buildings, diff.speed));
    if (events.includes('bottom')) g.shake = CFG.render.shakePeak;
    if (events.includes('bounce')) g.shake = Math.max(g.shake, CFG.render.bounceShake);
    if (events.includes('released')) { g.pose = pickTrickPose(g.rng); g.trickSec = CFG.trickSec; }
  } else fall(p, dt);
  g.trickSec = Math.max(0, g.trickSec - dt);
  if (!p.alive) g.pose = 'fall';
  else if (p.anchor) g.pose = 'swing';
  else if (g.trickSec === 0) g.pose = 'glide';
  if (g.missLine && (g.missLine.age += dt) > CFG.missShowSec) g.missLine = null;
  return events;
}

// Simple autopilot: while unattached, wait CFG.botWaitSec then press 'hi' (alternating R/L) and hold;
// release CFG.botHoldAfterBottomSec after the swing bottom. A miss is let go and retried.
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
    if (held) { held = false; wait = 0; return [{ type: 'release' }]; } // missed: let go, retry
    if ((wait += dt) < CFG.botWaitSec) return [];
    held = true; after = 0;
    const a = { type: 'press', side, level: 'hi' };
    side = side === 'R' ? 'L' : 'R';
    return [a];
  };
}
