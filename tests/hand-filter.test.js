import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneEuro, createHandsFilter, handQuality, FILTER_2D, FILTER_WORLD } from '../src/hand-filter.js';
import { hand, SHOOT, OPEN } from './hand-fixture.js';

const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const std = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const DT = 1 / 60;

for (const [name, P, sigma, step] of [['2D', FILTER_2D, 0.003, 0.2], ['world', FILTER_WORLD, 0.002, 0.05]]) {
  test(`One Euro ${name}: cuts jitter on a still noisy point by more than half`, () => {
    const r = rng(7), f = createOneEuro(P), raw = [], out = [];
    for (let k = 0; k < 300; k++) { const v = 0.5 + sigma * gauss(r); raw.push(v); out.push(f(v, k * DT)); }
    assert.ok(std(out.slice(60)) < 0.5 * std(raw.slice(60)), `${std(out.slice(60))} vs ${std(raw.slice(60))}`);
  });

  test(`One Euro ${name}: a step is followed within 4 frames (bounded lag)`, () => {
    const f = createOneEuro(P);
    for (let k = 0; k < 60; k++) f(0.5, k * DT);
    let v, k = 60;
    for (let n = 0; n < 4; n++, k++) v = f(0.5 + step, k * DT);
    assert.ok(Math.abs(v - (0.5 + step)) < 0.1 * step, `after 4 frames ${v}`);
  });
}

test('One Euro: a fast pull (zip) keeps most of its size drop within the zip window', () => {
  // hand size 0.13 shrinking 25 % over 120 ms: the filtered size must still show the 18 % zip drop by 250 ms
  const f = createOneEuro(FILTER_2D);
  let k = 0, v;
  for (; k < 60; k++) f(0.13, k * DT);
  for (let n = 0; n <= 15; n++, k++) v = f(0.13 * (1 - 0.25 * Math.min(1, n / 7)), k * DT);
  assert.ok(v < 0.13 * (1 - 0.2), `filtered ${v}`);
});

test('One Euro: a repeated timestamp returns the last value', () => {
  const f = createOneEuro(FILTER_2D);
  f(0.5, 1);
  assert.equal(f(0.9, 1), 0.5);
});

test('createHandsFilter: keeps each hand\'s own state, adds raw, drops vanished hands', () => {
  const F = createHandsFilter();
  const L = hand(0.25, 0.6, SHOOT), R = hand(0.75, 0.6, OPEN, { left: true });
  F([{ landmarks: L, world: L }, { landmarks: R, world: R }], 0);
  // order swapped next frame: each still converges to its own hand, not a blend of the two
  let out;
  for (let k = 1; k < 30; k++) out = F([{ landmarks: R, world: R }, { landmarks: L, world: L }], k * DT);
  assert.ok(Math.abs(out[0].landmarks[0].x - 0.75) < 1e-6 && Math.abs(out[1].landmarks[0].x - 0.25) < 1e-6);
  assert.equal(out[0].raw, R);
  out = F([{ landmarks: L }], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].world, undefined);
});

test('handQuality: green in the middle, yellow at the edge or low score, red when unsure', () => {
  assert.deepEqual(handQuality(hand(0.5, 0.6, OPEN), 0.97), { level: 'good', edge: false });
  assert.deepEqual(handQuality(hand(0.99, 0.6, OPEN), 0.97), { level: 'fair', edge: true });
  assert.equal(handQuality(hand(0.5, 0.6, OPEN), 0.8).level, 'fair');
  assert.equal(handQuality(hand(0.5, 0.6, OPEN), 0.5).level, 'poor');
});
