import test from 'node:test';
import assert from 'node:assert/strict';
import { createScore } from '../src/score.js';

const fakeStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

test('best starts at 0, submit keeps the max and persists', () => {
  const s = fakeStorage();
  const a = createScore(s);
  assert.equal(a.best(), 0);
  assert.equal(a.submit(100), true);
  assert.equal(a.best(), 100);
  assert.equal(a.submit(50), false);
  assert.equal(a.best(), 100);
  assert.equal(s.m.get('webrunner.best'), '100');
  assert.equal(createScore(s).best(), 100);
});

test('throwing storage falls back to memory', () => {
  const boom = () => { throw new Error('denied'); };
  const a = createScore({ getItem: boom, setItem: boom });
  assert.equal(a.submit(10), true);
  assert.equal(a.best(), 10);
  assert.doesNotThrow(() => createScore(undefined).submit(5));
});

test('garbage stored value reads as 0', () => {
  assert.equal(createScore(fakeStorage({ 'webrunner.best': 'abc' })).best(), 0);
});
