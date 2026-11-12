import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { aimVector, chargeLength, castWeb } from '../src/web.js';

test('aimVector: sign rules and unit length for all six', () => {
  for (const side of ['L', 'R']) for (const level of ['hi', 'mid', 'lo']) {
    const v = aimVector(side, level);
    assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-9);
    assert.ok(side === 'L' ? v.x < 0 : v.x > 0);
    assert.ok(v.z > 0);
    if (level === 'hi') assert.ok(v.y > 0);
    if (level === 'mid') assert.ok(Math.abs(v.y) < 0.15);
    if (level === 'lo') assert.ok(v.y < 0);
  }
});

test('chargeLength', () => {
  assert.equal(chargeLength(0), CFG.chargeMin);
  assert.equal(chargeLength(CFG.chargeFullSec / 2), (CFG.chargeMin + CFG.chargeMax) / 2);
  assert.equal(chargeLength(5), CFG.chargeMax);
  assert.equal(chargeLength(-1), CFG.chargeMin);
});

test('castWeb', () => {
  const o = { x: 0, y: 40, z: 0 };
  const d = aimVector('R', 'mid');
  const b = { side: 'R', z0: 5, z1: 50, h: 80 };
  const p = castWeb(o, d, CFG.chargeMax, [b]);
  assert.equal(p.x, CFG.corridorHalfWidth);
  assert.ok(p.z >= 5 && p.z <= 50);
  assert.equal(castWeb(o, d, 5, [b]), null);
  assert.equal(castWeb(o, d, CFG.chargeMax, [{ ...b, h: 10 }]), null);
  assert.equal(castWeb(o, d, CFG.chargeMax, [{ ...b, side: 'L' }]), null);
  const far = { side: 'R', z0: 60, z1: 90, h: 80 };
  assert.ok(castWeb(o, d, 200, [far, b]).z < 50);
});
