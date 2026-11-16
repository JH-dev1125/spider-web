import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { aimVector } from '../src/web.js';

const W = CFG.corridorHalfWidth;

test('aimVector: sign rules and unit length for all six', () => {
  for (const side of ['L', 'R']) {
    for (const level of ['hi', 'mid', 'lo']) {
      const v = aimVector(side, level);
      assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-12);
      assert.ok(side === 'L' ? v.x < 0 : v.x > 0);
      assert.ok(v.z > 0);
      assert.ok(level === 'hi' ? v.y > 0 : level === 'mid' ? v.y === 0 : v.y < 0);
    }
  }
});

test('every web meets its side face aimAhead metres ahead, from anywhere across the street', () => {
  for (const x of [-13, -7, 0, 7, 13]) {
    for (const side of ['L', 'R']) {
      for (const level of ['hi', 'mid', 'lo']) {
        const v = aimVector(side, level, x);
        const t = ((side === 'L' ? -W : W) - x) / v.x;
        assert.ok(Math.abs(v.z * t - CFG.aimAhead) < 1e-9, `${side} ${level} from x=${x}`);
        assert.ok(t <= CFG.webRange);
      }
    }
  }
});

test('hi is low enough to keep the anchor in view: under 15 m above the hand from the centre', () => {
  const v = aimVector('R', 'hi');
  const rise = (v.y / v.x) * W;
  assert.ok(rise > 10 && rise < 15, `rise ${rise}`);
});

test('W (side C): straight ahead along the street and steeply up, from anywhere across it', () => {
  for (const x of [-13, 0, 9]) for (const level of ['hi', 'mid', 'lo']) {
    const v = aimVector('C', level, x);
    assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-12);
    assert.equal(v.x, 0);
    assert.ok(v.z > 0 && v.y > Math.sin(15 * Math.PI / 180), `${level} not steep`);
  }
  assert.ok(aimVector('C', 'hi').y > aimVector('C', 'mid').y && aimVector('C', 'mid').y > aimVector('C', 'lo').y);
});
