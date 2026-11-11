// Pure per-frame game update shared by main.js and the headless bot test. No window/document.
import { CFG } from './config.js';
import { makeRng, difficulty, createWorld, updateWorld } from './world.js';
import { createPlayer, attach, stepPlayer } from './player.js';
import { aimVector, chargeLength, castWeb } from './web.js';

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
  const len = chargeLength(s.heldSec);
  const hit = castWeb(p.pos, dir, len, g.world.buildings);
  if (hit && attach(p, hit)) { g.missLine = null; return; }
  const o = p.pos;
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

// shots: [{side, level, heldSec}]. Returns stepPlayer's events ('bottom', 'released', 'bounce', 'dead').
export function stepGame(g, dt, shots) {
  dt = Math.min(dt, CFG.maxDt);
  const p = g.player;
  let events = [];
  g.shake *= Math.exp(-CFG.render.shakeDecay * dt);
  if (p.alive) {
    g.elapsed += dt;
    const diff = difficulty(g.elapsed);
    updateWorld(g.world, p.pos.z, g.elapsed, g.rng);
    for (const s of shots) fire(g, s);
    events = stepPlayer(p, dt, g.world.buildings, diff.speed);
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

// Simple autopilot: while unattached, charge CFG.botChargeSec, release a 'hi' shot, alternate R/L.
export function createBot() {
  let side = 'R';
  let held = 0;
  return (g, dt) => {
    if (g.player.anchor || !g.player.alive) { held = 0; return []; }
    held += Math.min(dt, CFG.maxDt);
    if (held < CFG.botChargeSec) return [];
    held = 0;
    const shot = { side, level: 'hi', heldSec: CFG.botChargeSec };
    side = side === 'R' ? 'L' : 'R';
    return [shot];
  };
}
