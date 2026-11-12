import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';

test('keys cover 6 unique side/level combos', () => {
  const keys = Object.keys(CFG.keys);
  assert.equal(keys.length, 6);
  const combos = new Set(Object.values(CFG.keys).map(([s, l]) => s + l));
  assert.equal(combos.size, 6);
  for (const [s, l] of Object.values(CFG.keys)) {
    assert.ok(['L', 'R'].includes(s));
    assert.ok(['hi', 'mid', 'lo'].includes(l));
  }
});



test('CFG deeply frozen', () => {
  assert.ok(Object.isFrozen(CFG));
  assert.ok(Object.isFrozen(CFG.keys));
  assert.ok(Object.isFrozen(CFG.keys.KeyQ));
});
