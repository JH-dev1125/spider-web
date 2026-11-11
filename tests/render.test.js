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
