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
      assert.ok(v.y > 0); // every web goes up: the anchor is above him, so the swing carries him forward
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

// Webs go high, so the rope is mostly up and forward and its sideways pull stays small next to his momentum.
test('high webs: from the centre hi rises 40-60 m, mid 25-35, lo 10-15; mid and hi ropes <= 20 deg off the forward plane', () => {
  const want = { hi: [40, 60], mid: [25, 35], lo: [10, 15] };
  for (const level of ['hi', 'mid', 'lo']) {
    const v = aimVector('R', level), t = W / v.x;
    const rise = v.y * t, ahead = v.z * t, side = Math.asin(W / t) / (Math.PI / 180);
    assert.ok(rise >= want[level][0] && rise <= want[level][1], `${level} rise ${rise}`);
    assert.ok(ahead >= 30 && ahead <= 50, `${level} ahead ${ahead}`);
    if (level !== 'lo') assert.ok(side <= 20, `${level} ${side} deg sideways`);
  }
});
