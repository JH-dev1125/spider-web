// Swing metrics for the bot (typical press / hold / release), reused by tests and by `node tests/swing-metrics.js`.
// A swing = from one attach to the next (or the run's end). Per swing:
//   side    = range of x while on the rope (m): how far the pendulum carried him sideways
//   forward = z gained from this attach to the next (m)
// Wall contacts: frames the hero starts touching a structure anywhere but its roof (side or front face).
import { CFG } from '../src/config.js';
import { createGame, stepGame, createBot } from '../src/game.js';

const DT = 1 / 60;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// Touching a box below its top (closest point within the hero's radius + skin, not straight beneath him).
function touching(p, structures) {
  const r = CFG.heroRadius + CFG.wallRunSkin + 0.05; // a wall run counts as touching
  for (const s of structures) {
    const c = { x: Math.max(s.min.x, Math.min(p.x, s.max.x)), y: Math.max(s.min.y, Math.min(p.y, s.max.y)), z: Math.max(s.min.z, Math.min(p.z, s.max.z)) };
    if (Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) < r && p.y < s.max.y) return true;
  }
  return false;
}

export function runSwings(seed, sec = 30, bot = createBot()) {
  const g = createGame(seed), p = g.player;
  const swings = [];
  let cur = null, touch = false, contacts = 0, wallruns = 0, t = 0;
  for (; t < sec && p.alive; t += DT) {
    const ev = stepGame(g, DT, bot(g, DT));
    if (ev.includes('wallrun')) wallruns++;
    if (p.anchor && (!cur || cur.anchor !== p.anchor)) {
      if (cur) cur.forward = p.pos.z - cur.z0;
      cur = { anchor: p.anchor, z0: p.pos.z, xMin: p.pos.x, xMax: p.pos.x, forward: 0 };
      swings.push(cur);
    }
    if (cur && p.anchor === cur.anchor) { cur.xMin = Math.min(cur.xMin, p.pos.x); cur.xMax = Math.max(cur.xMax, p.pos.x); }
    const now = touching(p.pos, g.world.structures);
    if (now && !touch) contacts++;
    touch = now;
  }
  if (cur) cur.forward = p.pos.z - cur.z0;
  return { seed, alive: p.alive, t, contacts, wallruns, swings: swings.map((s) => ({ side: s.xMax - s.xMin, forward: s.forward })) };
}

export function swingMetrics(seeds, sec = 30) {
  const runs = seeds.map((s) => runSwings(s, sec));
  const all = runs.flatMap((r) => r.swings.slice(0, -1)); // the last swing of a run is cut short
  const time = runs.reduce((a, r) => a + r.t, 0);
  return {
    runs: runs.length,
    survived: runs.filter((r) => r.alive).length,
    swings: all.length,
    medianSide: median(all.map((s) => s.side)),
    medianForward: median(all.map((s) => s.forward)),
    contactsPer10s: 10 * runs.reduce((a, r) => a + r.contacts, 0) / time,
    wallrunsPer10s: 10 * runs.reduce((a, r) => a + r.wallruns, 0) / time,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const m = swingMetrics(Array.from({ length: 40 }, (_, i) => i + 1));
  console.log(JSON.stringify(m, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v), 1));
}
