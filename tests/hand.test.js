import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createChargeTracker } from '../src/input-core.js';
import { hand, SHOOT } from './hand-fixture.js';

// Redirect the MediaPipe CDN import to a fake whose landmarker is globalThis.__fakeLandmarker.
const FAKE = `export const FilesetResolver = { forVisionTasks: async () => ({}) };
export const HandLandmarker = { createFromOptions: async () => globalThis.__fakeLandmarker };`;
registerHooks({
  resolve: (spec, ctx, next) => (spec.startsWith('https://cdn.jsdelivr.net/')
    ? { url: `data:text/javascript,${encodeURIComponent(FAKE)}`, shortCircuit: true } : next(spec, ctx)),
});
const { startHand, openCamera } = await import('../src/hand.js');

// Browser stand-ins: manual rAF queue, fake camera stream and video.
let rafQ = [];
globalThis.requestAnimationFrame = (f) => rafQ.push(f);
globalThis.cancelAnimationFrame = () => { rafQ = []; };
const tick = () => { const q = rafQ; rafQ = []; q.forEach((f) => f()); };
function setup(detect) {
  const env = { stopped: 0, closed: 0, t: 0, errors: [], statuses: [] };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => env.stopped++ }] }) },
  } });
  globalThis.__fakeLandmarker = { detectForVideo: detect, close: () => env.closed++ };
  env.video = { currentTime: 0, play: async () => {} };
  env.tracker = createChargeTracker();
  env.start = () => startHand(env.video, env.tracker, () => env.t, {
    onError: (e) => env.errors.push(e), onFrame: (st) => env.statuses.push(st),
  });
  env.frame = () => { env.video.currentTime += 1 / 30; env.t += 1 / 30; tick(); }; // one new camera frame
  return env;
}
const shootFrame = () => ({ landmarks: [hand(0.3, 0.5, SHOOT)], handedness: [[{ categoryName: 'Right' }]] });

test('startHand: a detect exception stops tracking, cancels the charge and calls onError', async () => {
  let fail = false;
  const env = setup(() => { if (fail) throw new Error('boom'); return shootFrame(); });
  await env.start();
  for (let k = 0; k < 3; k++) env.frame();
  assert.ok(env.tracker.state(env.t), 'charging');
  fail = true;
  env.frame();
  assert.equal(env.errors.length, 1);
  assert.equal(env.errors[0].message, 'boom');
  assert.equal(env.tracker.state(env.t), null);
  assert.equal(env.stopped, 1);
  assert.equal(env.closed, 1);
  assert.equal(rafQ.length, 0, 'loop ended');
});

test('startHand: lost-hand check keeps running while the camera stalls', async () => {
  const env = setup(shootFrame);
  await env.start();
  for (let k = 0; k < 3; k++) env.frame();
  assert.ok(env.tracker.state(env.t));
  for (let k = 0; k < 30; k++) { env.t += 1 / 60; tick(); } // 0.5 s of rAF, no new video frame
  assert.equal(env.tracker.state(env.t), null);
  assert.equal(env.statuses.at(-1).hands, 0);
  assert.equal(env.errors.length, 0);
});

test('startHand: with requestVideoFrameCallback, detects once per video frame and presses on the 2nd', async () => {
  let calls = 0, vfcQ = [];
  const env = setup(() => { calls++; return shootFrame(); });
  env.video.requestVideoFrameCallback = (f) => vfcQ.push(f);
  env.video.cancelVideoFrameCallback = () => { vfcQ = []; };
  const handle = await env.start();
  const videoFrame = () => { env.t += 1 / 30; const q = vfcQ; vfcQ = []; q.forEach((f) => f()); tick(); };
  videoFrame();
  assert.equal(env.tracker.state(env.t), null);
  videoFrame();
  assert.equal(calls, 2);
  assert.ok(env.tracker.state(env.t), 'pressed on the second frame');
  for (let k = 0; k < 5; k++) tick(); // rAF without a new video frame: no extra detection
  assert.equal(calls, 2);
  handle.stop();
  assert.equal(vfcQ.length, 0);
});

test('startHand rejects without getUserMedia', async () => {
  const env = setup(shootFrame);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  await assert.rejects(env.start());
});

// Fake camera that only offers `max` width; asks above it fail like Chrome does.
function fakeDevices(max, { deny = false, caps = {} } = {}) {
  const asked = [], applied = [];
  const err = (name) => Object.assign(new Error(name), { name });
  return { asked, applied, md: { getUserMedia: async (c) => {
    asked.push(c.video);
    if (deny) throw err('NotAllowedError');
    const w = c.video.width?.min ?? 0;
    if (w > max) throw err('OverconstrainedError');
    const track = { label: 'Fake cam', stop() {}, getCapabilities: () => caps,
      applyConstraints: async (x) => { applied.push(x); }, getSettings: () => ({ width: c.video.width?.ideal ?? max, height: 0, frameRate: 30 }) };
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  } } };
}

test('openCamera: asks 1280x720@60 front camera without browser crop first', async () => {
  const f = fakeDevices(1920, { caps: { exposureMode: ['manual', 'continuous'] } });
  const { settings } = await openCamera(f.md);
  assert.equal(f.asked.length, 1);
  assert.deepEqual(f.asked[0].width, { min: 1280, ideal: 1280 });
  assert.equal(f.asked[0].facingMode, 'user');
  assert.deepEqual(f.asked[0].frameRate, { ideal: 60 });
  assert.deepEqual(f.asked[0].resizeMode, { ideal: 'none' });
  assert.equal(settings.width, 1280);
  assert.equal(settings.label, 'Fake cam');
  assert.deepEqual(f.applied, [{ advanced: [{ exposureMode: 'continuous' }] }]);
});

test('openCamera: falls back 1280 -> 960 -> 640 -> anything', async () => {
  let f = fakeDevices(1000);
  assert.equal((await openCamera(f.md)).settings.width, 960);
  assert.deepEqual(f.asked.map((v) => v.width.min), [1280, 960]);
  f = fakeDevices(320);
  await openCamera(f.md);
  assert.deepEqual(f.asked.map((v) => v.width?.min), [1280, 960, 640, undefined]);
  assert.equal(f.applied.length, 0, 'no exposure hint without the capability');
});

test('openCamera: a denied permission is not retried down the ladder', async () => {
  const f = fakeDevices(1920, { deny: true });
  await assert.rejects(openCamera(f.md), { name: 'NotAllowedError' });
  assert.equal(f.asked.length, 1);
});

test('startHand: reports camera settings, smoothed hands with raw and quality, and latency stats', async () => {
  const env = setup(shootFrame);
  let got;
  const handle = await startHand(env.video, env.tracker, () => env.t, { onFrame: (st, hands, stats) => { got = { hands, stats }; } });
  for (let k = 0; k < 3; k++) env.frame();
  assert.equal(got.stats, handle.stats);
  assert.equal(got.stats.delegate, 'GPU');
  assert.ok(got.stats.frameMs >= 0 && got.stats.detectMs >= 0 && got.stats.actionMs >= 0, 'pressed: action latency measured');
  assert.equal(got.hands[0].raw.length, 21);
  assert.ok(['good', 'fair', 'poor'].includes(got.stats.quality));
  handle.stop();
});
