import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FX, fxTargets, ease, createFrameGuard } from '../src/postfx-math.js';

const v = (x, y, z) => ({ x, y, z });

test('slow and level: no blur, no fov kick', () => {
  for (const vel of [v(0, 0, 0), v(0, 0, 20), v(5, -8, 15)]) {
    const t = fxTargets(vel);
    assert.equal(t.blur, 0); assert.equal(t.fov, 0);
  }
});

test('blur grows with speed, a flat swing stays below a dive', () => {
  const a = fxTargets(v(0, 0, 25)).blur, b = fxTargets(v(0, 0, 30)).blur, c = fxTargets(v(0, 0, 200)).blur;
  assert.ok(a > 0 && b > a && c >= b);
  assert.ok(c <= FX.blurSpeedMax + 1e-9);
  assert.equal(fxTargets(v(0, -40, 0)).blur, 1);
});

test('fov kick is modest: 0 until high speed or a dive, never above 10 degrees', () => {
  assert.equal(fxTargets(v(0, 0, 25)).fov, 0, 'an ordinary fast swing gets no kick');
  assert.ok(fxTargets(v(0, 0, 33)).fov > 0);
  assert.ok(fxTargets(v(0, -20, 0)).fov > 0, 'a dive kicks');
  for (const vel of [v(0, 0, 1e4), v(0, -1e4, 0), v(1e4, -1e4, 1e4)]) assert.ok(fxTargets(vel).fov <= 10);
  assert.ok(fxTargets(v(0, 24, 0)).fov === 0, 'flying up is not a dive');
});

test('ease is dt-based: converges, never overshoots, in faster than out', () => {
  let x = 0;
  for (let i = 0; i < 300; i++) { x = ease(x, 1, 1 / 60); assert.ok(x <= 1); }
  assert.ok(x > 0.99);
  assert.ok(ease(0, 1, 0.1) > 1 - ease(1, 0, 0.1), 'rises faster than it falls');
  assert.ok(Math.abs(ease(0, 1, 0.1) - ease(ease(0, 1, 0.05), 1, 0.05)) < 1e-9, 'same result for split steps');
});

test('frame guard: off only after > 20 ms frames for about 2 s, and stays off', () => {
  const g = createFrameGuard();
  for (let i = 0; i < 600; i++) assert.ok(g.tick(1 / 60), '60 fps stays on');
  for (let i = 0; i < 60; i++) g.tick(0.025); // 1.5 s slow
  assert.ok(!g.off);
  for (let i = 0; i < 60; i++) g.tick(1 / 60); // recovers: the clock resets
  for (let i = 0; i < 60; i++) g.tick(0.025);
  assert.ok(!g.off, 'a slow spell under 2 s after a recovery does not count');
  for (let i = 0; i < 60; i++) g.tick(0.025);
  assert.ok(g.off);
  assert.equal(g.tick(1 / 120), false, 'stays off');
});

test('frame guard ignores hitches and tab switches', () => {
  const g = createFrameGuard();
  for (let i = 0; i < 40; i++) g.tick(1.0);
  assert.ok(!g.off);
});
