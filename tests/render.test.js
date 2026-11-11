import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { project, makeCamera, pickTrickPose } from '../src/render.js';
import { createPlayer } from '../src/player.js';
import { makeRng } from '../src/world.js';

const W = 1280, H = 720;
const cam = { x: 0, y: 10, z: 0, fovDeg: 70 };

test('point straight ahead projects to screen centre', () => {
  const p = project({ x: 0, y: 10, z: 50 }, cam, W, H);
  assert.ok(Math.abs(p.sx - W / 2) < 1e-9);
  assert.ok(Math.abs(p.sy - H / 2) < 1e-9);
});

test('farther point has smaller scale', () => {
  const a = project({ x: 0, y: 10, z: 20 }, cam, W, H);
  const b = project({ x: 0, y: 10, z: 80 }, cam, W, H);
  assert.ok(b.scale < a.scale);
});

test('right x is right of centre, higher y is above camera-height point', () => {
  assert.ok(project({ x: 5, y: 10, z: 30 }, cam, W, H).sx > W / 2);
  const up = project({ x: 0, y: 20, z: 30 }, cam, W, H);
  const level = project({ x: 0, y: 10, z: 30 }, cam, W, H);
  assert.ok(up.sy < level.sy);
});

test('points behind or inside near plane are null', () => {
  assert.equal(project({ x: 0, y: 10, z: -5 }, cam, W, H), null);
  assert.equal(project({ x: 0, y: 10, z: CFG.camNear }, cam, W, H), null);
});

test('scale is focal length over depth', () => {
  const f = (H / 2) / Math.tan((cam.fovDeg * Math.PI) / 360);
  const p = project({ x: 0, y: 0, z: 40 }, cam, W, H);
  assert.ok(Math.abs(p.scale - f / 40) < 1e-9);
});

test('makeCamera without prev sits behind and above the player', () => {
  const p = createPlayer();
  const c = makeCamera(p, null, 1 / 60);
  assert.ok(Math.abs(c.x - p.pos.x) < 1e-9);
  assert.ok(Math.abs(c.y - (p.pos.y + CFG.camUp)) < 1e-9);
  assert.ok(Math.abs(c.z - (p.pos.z - CFG.camBack)) < 1e-9);
});

test('faster player gives wider fov, never above fovMax', () => {
  const slow = createPlayer();
  const fast = createPlayer();
  fast.vel.z = CFG.maxSpeed;
  const huge = createPlayer();
  huge.vel.z = CFG.maxSpeed * 10;
  const a = makeCamera(slow, null, 1 / 60).fovDeg;
  const b = makeCamera(fast, null, 1 / 60).fovDeg;
  assert.ok(b > a);
  assert.ok(makeCamera(huge, null, 1 / 60).fovDeg <= CFG.fovMax);
  assert.ok(a >= CFG.fovMin);
});

test('camera smoothing: partial step, frame-rate independent', () => {
  const p = createPlayer();
  const prev = makeCamera(p, null, 1 / 60);
  p.pos.x += 4; p.pos.y += 4; p.pos.z += 4; // attach() reel snap
  const one = makeCamera(p, prev, 1 / 30);
  assert.ok(one.x > prev.x && one.x < p.pos.x);
  assert.ok(one.y > prev.y && one.z > prev.z);
  const twoSteps = makeCamera(p, makeCamera(p, prev, 1 / 60), 1 / 60);
  for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(twoSteps[k] - one[k]) < 1e-9);
});

test('pickTrickPose returns only trick poses and covers all of them', () => {
  const rng = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickTrickPose(rng));
  assert.deepEqual([...seen].sort(), ['glide', 'roll', 'tuck']);
});

// Recording stub: every method records its numeric args; gradients return the stub itself.
function stubCtx() {
  const nums = [];
  const pts = [];
  const ctx = new Proxy({}, {
    get(o, k) {
      if (k in o) return o[k];
      return (...args) => {
        for (const a of args) if (typeof a === 'number') nums.push([k, a]);
        if (k === 'moveTo' || k === 'lineTo') pts.push(args);
        return k === 'createLinearGradient' ? ctx : undefined;
      };
    },
    set(o, k, v) { o[k] = v; return true; },
  });
  return { ctx, nums, pts };
}

test('drawFrame smoke: finite coords, nothing emitted from inside the near plane', async () => {
  const { drawFrame } = await import('../src/render.js');
  for (const pose of ['swing', 'glide', 'roll', 'tuck', 'fall']) {
    for (const camY of [10, 200]) { // below and above roofs
      const p = createPlayer();
      p.pos.y = camY;
      p.vel.z = CFG.maxSpeed; // speed lines on
      const cam = makeCamera(p, null, 0);
      p.anchor = { x: -CFG.corridorHalfWidth, y: camY + 10, z: cam.z - 3 }; // anchor behind the camera
      const buildings = [
        { side: 'L', z0: cam.z - 10, z1: cam.z + 30, h: 60 }, // straddles cam.z
        { side: 'R', z0: cam.z + CFG.camNear * 0.5, z1: cam.z + 50, h: 120 }, // starts inside near plane
        { side: 'R', z0: cam.z + 80, z1: cam.z + 140, h: 40 },
        { side: 'L', z0: cam.z - 60, z1: cam.z - 20, h: 40 }, // fully behind
      ];
      const { ctx, nums, pts } = stubCtx();
      drawFrame(ctx, W, H, {
        player: p, buildings, cam, pose, t: 1.234, shake: 3,
        aim: { side: 'R', level: 'lo', heldSec: 0.5 },
        missLine: { to: { x: CFG.corridorHalfWidth, y: 0, z: cam.z - 5 }, age: 0.1 },
      });
      assert.ok(pts.length > 50, 'something was drawn');
      // projectTo turns rejected points into NaN, so this also proves no dz <= camNear point reached a path
      for (const [k, v] of nums) assert.ok(Number.isFinite(v), `${pose}/${camY}: ${k} got ${v}`);
    }
  }
});

test('project rejects at camNear and matches drawFrame focal length', () => {
  const c = { x: 0, y: 0, z: 0, fovDeg: 90 };
  assert.equal(project({ x: 0, y: 0, z: CFG.camNear }, c, W, H), null);
  const p = project({ x: 1, y: 0, z: 1 }, c, W, H); // tan(45deg) = 1 -> focal = H/2
  assert.ok(Math.abs(p.sx - (W / 2 + H / 2)) < 1e-9);
});
