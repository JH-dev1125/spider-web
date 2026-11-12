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
  const b = { side: 'R', z0: 40, z1: 70, h: 80 };
  const p = castWeb(o, d, CFG.webRange, [b]);
  assert.equal(p.x, CFG.corridorHalfWidth);
  assert.ok(p.z >= 40 && p.z <= 70);
  assert.equal(castWeb(o, d, 5, [b]), null);
  assert.equal(castWeb(o, d, CFG.webRange, [{ ...b, h: 10 }]), null);
  assert.equal(castWeb(o, d, CFG.webRange, [{ ...b, side: 'L' }]), null);
  const far = { side: 'R', z0: 80, z1: 120, h: 80 };
  assert.ok(castWeb(o, d, 200, [far, b]).z < 70);
});

test('forward aim: from the corridor centre every level lands 45-60 m ahead, within webRange', () => {
  for (const level of ['hi', 'mid', 'lo']) {
    const p = castWeb({ x: 0, y: 60, z: 0 }, aimVector('R', level), CFG.webRange, [{ side: 'R', z0: 0, z1: 500, h: 200 }]);
    assert.ok(p && p.z >= 45 && p.z <= 60, `${level}: ${p && p.z}`);
  }
});
