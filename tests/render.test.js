// render.js needs three.js + WebGL; these cover its pure helpers (render-math.js, character.js pose math).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { followCamera, speedK, shakeOffset, speedLineK, wrapZ, surfaceNormal } from '../src/render-math.js';
import { poseTarget, blendPose, flipAngle, JOINTS } from '../src/character.js';
import { createPlayer } from '../src/player.js';
import { createGame, stepGame, createBot } from '../src/game.js';

const R = CFG.render;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('camera without prev sits behind and above the player, looking ahead', () => {
  const p = createPlayer();
  const c = followCamera(p, null, 1 / 60);
  assert.ok(near(c.x, p.pos.x));
  assert.ok(near(c.y, p.pos.y + R.camUp));
  assert.ok(near(c.z, p.pos.z - R.camBack));
  assert.ok(c.lz > p.pos.z, 'looks ahead of the hero');
});

test('faster player gives wider fov, clamped to [fovMin, fovMax]', () => {
  const slow = createPlayer(), fast = createPlayer(), huge = createPlayer();
  fast.vel.z = CFG.maxSpeed;
  huge.vel.z = CFG.maxSpeed * 10;
  const a = followCamera(slow, null, 0).fovDeg;
  assert.ok(near(a, R.fovMin));
  assert.ok(followCamera(fast, null, 0).fovDeg > a);
  assert.ok(near(followCamera(huge, null, 0).fovDeg, R.fovMax));
  assert.equal(speedK({ x: 0, y: 0, z: 0 }), 0);
});

test('camera smoothing: partial step, frame-rate independent', () => {
  const p = createPlayer();
  const prev = followCamera(p, null, 1 / 60);
  p.pos.x += 0.5; p.pos.y += 0.5; // within the leash (a bigger jump is pulled in, on purpose); z still leads by vel.z
  const one = followCamera(p, prev, 1 / 30);
  assert.ok(one.x > prev.x && one.x < p.pos.x);
  assert.ok(one.y > prev.y && one.z > prev.z);
  const two = followCamera(p, followCamera(p, prev, 1 / 60), 1 / 60);
  for (const k of ['x', 'y', 'z', 'lx', 'ly', 'lz', 'fovDeg']) assert.ok(near(two[k], one[k]), k);
});

test('steady forward flight keeps the camera ~camBack behind (z lead; discrete steps leave a small residue)', () => {
  const p = createPlayer();
  let c = followCamera(p, null, 0);
  for (let i = 0; i < 600; i++) { p.pos.z += p.vel.z / 60; c = followCamera(p, c, 1 / 60); }
  assert.ok(near(c.z, p.pos.z - R.camBack, 0.3), `${p.pos.z - c.z}`);
});

test('a restart teleport snaps the camera', () => {
  const p = createPlayer();
  const far = followCamera(p, null, 0);
  p.pos.z += 5000;
  assert.ok(near(followCamera(p, far, 1 / 60).z, p.pos.z - R.camBack));
});

test('shake is zero at rest and bounded', () => {
  assert.deepEqual(shakeOffset(0, 1.3).map(Math.abs), [0, 0]);
  for (const v of shakeOffset(R.shakePeak, 0.7)) assert.ok(Math.abs(v) <= R.shakePeak * R.shakeM);
  assert.equal(speedLineK(CFG.baseSpeed), 0);
  assert.equal(speedLineK(CFG.baseSpeed * R.speedLineFull * 2), 1);
});

test('wrapZ lands in the window and keeps the period', () => {
  for (const z of [-3000, -1, 0, 7, 999, 12345.5]) for (const camZ of [0, 400.25, 9000]) {
    const w = wrapZ(z, camZ, 250, 1000);
    assert.ok(w >= camZ - 250 && w < camZ + 750, `${z} ${camZ} -> ${w}`);
    assert.ok(near((w - z) / 1000, Math.round((w - z) / 1000), 1e-9));
  }
});

test('every pose gives finite joints; unknown pose falls back to glide', () => {
  for (const pose of [...Object.keys(CFG.character.poses), 'nope']) {
    for (const mirror of [false, true]) {
      const t = poseTarget(pose, 1.7, mirror);
      assert.equal(t.length, JOINTS.length * 3);
      assert.ok(t.every(Number.isFinite), pose);
    }
  }
  assert.deepEqual(poseTarget('nope', 0, false), poseTarget('glide', 0, false));
});

test('swing raises the web arm; mirroring moves it to the other side', () => {
  const i = (j) => JOINTS.indexOf(j) * 3;
  const r = poseTarget('swing', 0, false), l = poseTarget('swing', 0, true);
  assert.ok(r[i('shR') + 2] > 2.5, 'right arm overhead (+z raises the right arm)');
  assert.ok(l[i('shL') + 2] < -2.5, 'mirrored: left arm overhead (mirrored sign)');
  assert.ok(near(l[i('shL') + 2], -r[i('shR') + 2]));
  // symmetric pose: left = mirrored right
  const g = poseTarget('glide', 0, false);
  assert.ok(near(g[i('shL') + 2], -g[i('shR') + 2]));
});

test('blendPose eases frame-rate independently and converges', () => {
  const a = poseTarget('glide', 0, false), b = poseTarget('tuck', 0, false);
  const one = blendPose(Float64Array.from(a), b, 1 / 30);
  const two = blendPose(blendPose(Float64Array.from(a), b, 1 / 60), b, 1 / 60);
  for (let k = 0; k < a.length; k++) assert.ok(near(one[k], two[k]));
  const done = blendPose(Float64Array.from(a), b, 10);
  for (let k = 0; k < a.length; k++) assert.ok(near(done[k], b[k], 1e-6));
});

test('trick flips make exactly one turn over trickSec', () => {
  assert.equal(flipAngle('roll', 0), 0);
  assert.ok(near(flipAngle('tuck', CFG.trickSec), Math.PI * 2));
  assert.ok(near(flipAngle('roll', CFG.trickSec * 5), Math.PI * 2));
  assert.equal(flipAngle('glide', 0.3), 0);
  assert.equal(flipAngle('swing', 0.3), 0);
});

// Project in the camera basis without needing WebGL or a CDN in the Node suite.
function inFrame(c, p, aspect) {
  const norm = (v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
  const f = norm([c.lx - c.x, c.ly - c.y, c.lz - c.z]);
  const r = norm([f[2], 0, -f[0]]);
  const u = [f[1] * r[2], f[2] * r[0] - f[0] * r[2], -f[1] * r[0]];
  const d = [p.x - c.x, p.y - c.y, p.z - c.z];
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const depth = dot(d, f), h = depth * Math.tan(c.fovDeg * Math.PI / 360);
  return depth > 0 && Math.abs(dot(d, r)) < h * aspect && Math.abs(dot(d, u)) < h;
}

// No FOV widening to fit anchors (it read as fisheye): a normal lens looking ahead already frames hi webs.
test('hi webs and the hero stay framed with a normal lens', () => {
  for (const aspect of [16 / 9]) for (const x of [-13.5, 0, 13.5]) {
    const p = createPlayer(); p.pos.x = x;
    let c = followCamera(p, null, 0);
    for (const side of [-1, 1]) {
      const target = { x: side * 14, y: p.pos.y + 14.3, z: p.pos.z + 52 };
      for (let i = 0; i < 45; i++) {
        p.pos.z += p.vel.z / 60; // the hero keeps flying (a frozen hero lets the z lead overtake him)
        c = followCamera(p, c, 1 / 60);
        for (const point of [p.pos, { ...p.pos, y: p.pos.y - 1.1 }, target]) {
          assert.ok(inFrame(c, point, aspect), `${x}, ${side}, ${aspect}, frame ${i}`);
        }
      }
    }
  }
});

test('anchor decals use the nearest box face, including bridge undersides and crane ends', () => {
  const structures = [{ min: { x: -16, y: 30, z: 50 }, max: { x: 16, y: 33, z: 55 } }];
  assert.deepEqual(surfaceNormal({ x: 2, y: 30, z: 52 }, structures), { x: 0, y: -1, z: 0 });
  assert.deepEqual(surfaceNormal({ x: 16, y: 32, z: 52 }, structures), { x: 1, y: 0, z: 0 });
  assert.deepEqual(surfaceNormal({ x: 0, y: 32, z: 50 }, structures), { x: 0, y: 0, z: -1 });
});

test('camera has no position jump at the corridor edge', () => {
  const p = createPlayer();
  p.pos.x = CFG.corridorHalfWidth - 0.001;
  const a = followCamera(p, null, 0);
  p.pos.x += 0.002;
  const b = followCamera(p, null, 0);
  assert.ok(Math.abs(b.x - a.x) < 0.003);
});

// "The hero is a 40 px speck far ahead": run real swings (fast release, zips, wall runs) through the camera and
// check every frame that he stays big (>= 1/5 of the screen height), near the middle, within the leash, and the
// camera never sits inside a box.
const heroScreen = (c, p) => {
  const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
  const f = norm([c.lx - c.x, c.ly - c.y, c.lz - c.z]);
  const r = norm([f[2], 0, -f[0]]);
  const u = [f[1] * r[2], f[2] * r[0] - f[0] * r[2], -f[1] * r[0]];
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const d = [p.x - c.x, p.y - c.y, p.z - c.z], depth = dot(d, f), half = depth * Math.tan(c.fovDeg * Math.PI / 360);
  return { height: CFG.character.height / (2 * half), sx: dot(d, r) / half, sy: dot(d, u) / half, depth };
};
const W = CFG.corridorHalfWidth, DT = 1 / 60;
const WANT = Math.hypot(R.camWallGap, R.camUp, R.camBack); // the largest desired offset (at a wall)
const corridor = (g) => {
  g.world.structures = [
    { id: 'CL:base', kind: 'tower', attach: true, min: { x: -W - 20, y: 0, z: -50 }, max: { x: -W, y: 200, z: 3000 } },
    { id: 'CR:base', kind: 'tower', attach: true, min: { x: W, y: 0, z: -50 }, max: { x: W + 20, y: 200, z: 3000 } },
  ];
  g.world.nextZ = { L: Infinity, R: Infinity };
};
// Runs the bot (zipping or not) for up to `sec` with the camera; calls check(frame info) every frame.
function filmBot(seed, zip, sec, setupCourse, check) {
  const g = createGame(seed), bot = createBot({ zip });
  setupCourse?.(g);
  let c = null;
  const seen = new Set();
  for (let i = 0; i < 60 * sec && g.player.alive; i++) {
    for (const e of stepGame(g, DT, bot(g, DT))) seen.add(e);
    const p = g.player;
    c = followCamera(p, c, DT, g.world.structures);
    check({ c, p, s: heroScreen(c, p.pos), at: `seed ${seed} zip ${zip} frame ${i}`, g });
  }
  return seen;
}
const leashOk = ({ c, p, at }) => assert.ok(Math.hypot(c.x - p.pos.x, c.y - p.pos.y, c.z - p.pos.z) <= WANT * CFG.camLeash + 1e-9, `${at}: beyond the leash`);
const framed = (s) => s.depth > 0 && s.height >= 0.2 && Math.abs(s.sx) < 0.6 * 16 / 9 && Math.abs(s.sy) < 0.6;

test('camera: through swing ends, fast releases, zips and wall runs the hero stays >= 1/5 of the screen, central, leashed', () => {
  const seen = new Set();
  for (const seed of [1, 2, 3, 4]) for (const zip of [false, true]) {
    let fast = 0;
    const ev = filmBot(seed, zip, 15, corridor, (f) => {
      leashOk(f);
      assert.ok(framed(f.s), `${f.at}: hero ${(f.s.height * 100).toFixed(1)}% tall at ${f.s.sx.toFixed(2)}, ${f.s.sy.toFixed(2)}`);
      assert.ok(f.c.fovDeg >= R.fovMin - 1e-9 && f.c.fovDeg <= R.fovMax + 1e-9);
      for (const b of f.g.world.structures) assert.ok(!['x', 'y', 'z'].every((k) => f.c[k] > b.min[k] && f.c[k] < b.max[k]), `${f.at}: camera inside ${b.id}`);
      fast = Math.max(fast, Math.hypot(f.p.vel.x, f.p.vel.y, f.p.vel.z));
    });
    ev.forEach((e) => seen.add(e));
    assert.ok(fast > 30, `seed ${seed}: never fast (${fast.toFixed(1)} m/s)`);
  }
  for (const e of ['released', 'zipped', 'wallrun', 'walljump']) assert.ok(seen.has(e), `never saw ${e}`);
});

// Generated courses add alleys and back lots where a tower can stand right behind him: the spring arm then pulls
// the camera in. The leash always holds; framing holds on all but a sliver of frames.
test('camera on generated courses: always leashed, the hero framed >= 99.5% of frames', () => {
  let n = 0, good = 0;
  for (let seed = 1; seed <= 8; seed++) for (const zip of [false, true]) filmBot(seed, zip, 15, null, (f) => { leashOk(f); n++; if (framed(f.s)) good++; });
  assert.ok(good / n >= 0.995, `${n - good} of ${n} frames off`);
});

test('wallrun pose strides with t (legs in opposite phase); walljump is a static tuck', () => {
  const hip = (pose, t, j) => poseTarget(pose, t, false)[JOINTS.indexOf(j) * 3];
  const T = Math.PI / 2 / CFG.character.runFreq; // a quarter stride
  assert.ok(hip('wallrun', T, 'hipL') - hip('wallrun', 0, 'hipL') > 0.5);
  assert.ok(hip('wallrun', T, 'hipR') - hip('wallrun', 0, 'hipR') < -0.5);
  assert.equal(hip('walljump', 0, 'hipL'), hip('walljump', 1, 'hipL'));
});
