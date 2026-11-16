import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipLaunch } from '../src/zip.js';
import { CFG } from '../src/config.js';

test('zip is a finite, immutable additive delta-v within 30 degrees of travel heading', () => {
  for (const bias of [.4, .5, .6]) for (let yaw = 0; yaw < Math.PI * 2; yaw += .2) for (let a = 0; a < Math.PI * 2; a += .2) {
    const heading = { x: Math.sin(yaw), y: 9, z: Math.cos(yaw) };
    const rope = { x: Math.sin(a), y: .8, z: Math.cos(a) };
    const vel = { x: 3, y: -10, z: 12 }, before = JSON.stringify([vel, heading, rope]);
    const { dv, dir } = zipLaunch(vel, heading, rope, { ...CFG, zipRopeBias: bias });
    assert.ok(Object.values(dir).every(Number.isFinite));
    assert.ok((dir.x * heading.x + dir.z * heading.z) / Math.hypot(dir.x, dir.z) >= Math.cos(Math.PI / 6) - 1e-9);
    assert.ok(Math.abs(Math.hypot(dir.x, dir.y, dir.z) - 1) < 1e-9);
    assert.ok(Math.abs(Math.hypot(dv.x, dv.y, dv.z) - CFG.zipLaunch) < 1e-9);
    assert.equal(JSON.stringify([vel, heading, rope]), before);
  }
});

test('zip uses travel velocity when heading is zero, +z when stationary, and never dives', () => {
  const zero = { x: 0, y: 0, z: 0 };
  assert.deepEqual(zipLaunch(zero, zero, zero, CFG), { dv: { x: 0, y: 0, z: CFG.zipLaunch }, dir: { x: 0, y: 0, z: 1 } });
  const { dir } = zipLaunch({ x: 10, y: -20, z: 0 }, zero, { x: 0, y: -1, z: 0 }, CFG);
  assert.deepEqual(dir, { x: 1, y: 0, z: 0 });
});

test('zip normalizes rope input, honors tuning, and rejects nonfinite inputs', () => {
  const v = { x: 0, y: 0, z: 1 }, rope = { x: 1, y: 2, z: 0 };
  assert.deepEqual(zipLaunch(v, v, rope, CFG), zipLaunch(v, v, { x: 10, y: 20, z: 0 }, CFG));
  const cfg = { ...CFG, zipLaunch: 22, zipRopeBias: .6 };
  assert.ok(Math.abs(Math.hypot(...Object.values(zipLaunch(v, v, rope, cfg).dv)) - 22) < 1e-8);
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => zipLaunch({ x: bad, y: 0, z: 0 }, v, rope, CFG), RangeError);
  assert.throws(() => zipLaunch(v, v, rope, { ...CFG, zipLaunch: -1 }), RangeError);
  assert.throws(() => zipLaunch(v, v, rope, { ...CFG, zipRopeBias: .9 }), RangeError);
});
