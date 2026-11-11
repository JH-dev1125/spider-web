import { CFG } from './config.js';
import { createWorld, updateWorld, makeRng } from './world.js';
import { createPlayer, attach, stepPlayer } from './player.js';
import { aimVector, castWeb } from './web.js';
import { makeCamera, drawFrame, pickTrickPose } from './render.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let w = 0, h = 0;

function resize() {
  const dpr = Math.min(CFG.maxDpr, window.devicePixelRatio || 1);
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// Task 6 debug harness, replaced by Task 7 wiring.
// ?debugPose=<pose> or keys 1-5 pick a pose; ?demo autopilots swings; ?t=<sec> fast-forwards the demo;
// ?aim=R,hi shows a half-charged aim preview.
const POSES = ['swing', 'glide', 'roll', 'tuck', 'fall'];
const q = new URLSearchParams(location.search);
let pose = q.get('debugPose') || 'glide';
const demo = q.has('demo');
const aimQ = q.get('aim')?.split(',');
const aim = aimQ && { side: aimQ[0], level: aimQ[1], heldSec: 0.5 };
window.addEventListener('keydown', (e) => {
  const p = POSES[Number(e.key) - 1];
  if (p) pose = p;
});

const rng = makeRng(1);
const world = createWorld();
let player = createPlayer();
let cam = null;
let elapsed = 0;
let shake = 0;
let side = 'R';

function step(dt) {
  elapsed += dt;
  updateWorld(world, player.pos.z, elapsed, rng);
  if (demo) {
    if (!player.anchor && player.vel.y < 0) { // fire on the way down
      const o = { x: player.pos.x, y: player.pos.y, z: player.pos.z };
      const hit = castWeb(o, aimVector(side, 'hi'), CFG.chargeMax, world.buildings);
      if (hit && attach(player, hit)) side = side === 'R' ? 'L' : 'R';
    }
    const was = player.swingPhase;
    const ev = stepPlayer(player, dt, world.buildings, CFG.baseSpeed);
    if (was === 'descending' && player.swingPhase !== 'descending') shake = CFG.render.shakePeak; // bottom of the swing
    if (ev.includes('released')) pose = pickTrickPose(rng);
    if (player.anchor) pose = 'swing';
    if (!player.alive) { player = createPlayer(); cam = null; }
  }
  shake *= Math.exp(-CFG.render.shakeDecay * dt);
  cam = makeCamera(player, cam, dt);
}

const ff = Number(q.get('t')) || 0;
for (let s = 0; s < ff; s += 1 / 60) step(1 / 60);
step(0);

let last = performance.now();
function frame(now) {
  const dt = Math.min(CFG.maxDt, (now - last) / 1000);
  last = now;
  step(dt);
  drawFrame(ctx, w, h, {
    player, buildings: world.buildings, cam, aim, missLine: null, pose, t: elapsed, shake,
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
