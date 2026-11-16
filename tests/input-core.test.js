import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargeTracker } from '../src/input-core.js';
import { attachKeyboard } from '../src/keyboard.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('press/state/release basic', () => {
  const tr = createChargeTracker();
  assert.equal(tr.state(0), null);
  tr.press('R', 'hi', 0);
  const s = tr.state(0.4);
  assert.equal(s.side, 'R'); assert.equal(s.level, 'hi'); near(s.heldSec, 0.4);
  const r = tr.release('R', 'hi', 0.4);
  assert.deepEqual(r, { side: 'R', level: 'hi', heldSec: 0.4 });
  assert.equal(tr.state(0.5), null);
});

test('per side: L and R held together; a release lets go of its own side only', () => {
  const tr = createChargeTracker();
  tr.press('L', 'mid', 0); tr.press('R', 'lo', 0.2);
  assert.equal(tr.state(0.3).side, 'R', 'state() without a side = the most recent');
  assert.equal(tr.state(0.3, 'L').level, 'mid');
  near(tr.release('L', 'mid', 0.3).heldSec, 0.3);
  assert.equal(tr.state(0.3, 'L'), null);
  assert.equal(tr.state(0.3, 'R').level, 'lo');
  near(tr.release('R', 'lo', 0.5).heldSec, 0.3);
});

test('same side: a new press replaces that side; the superseded key is stale; release(null) lets go of all', () => {
  const tr = createChargeTracker();
  tr.press('L', 'hi', 0); tr.press('R', 'mid', 0); tr.press('L', 'lo', 0.4);
  assert.equal(tr.release('L', 'hi', 0.5), null);
  near(tr.state(0.5, 'L').heldSec, 0.1);
  const r = tr.release(null, null, 0.6);
  assert.deepEqual([r.side, r.level], ['L', 'lo']);
  assert.equal(tr.state(0.6), null);
  assert.equal(tr.release(null, null, 0.7), null);
});

test('cancel and no-aim cases', () => {
  const tr = createChargeTracker();
  assert.equal(tr.release('L', 'hi', 0), null);
  assert.equal(tr.state(0), null);
  tr.press('L', 'hi', 0); tr.cancel();
  assert.equal(tr.release('L', 'hi', 1), null);
  assert.equal(tr.release(null, null, 1), null);
});

test('attachKeyboard: press fires at once, keyup of the active key releases, blur releases', () => {
  const target = new EventTarget();
  const tr = createChargeTracker();
  const acts = [];
  let t = 0;
  const off = attachKeyboard(target, tr, () => t, (a) => acts.push(a));
  const fire = (type, code, repeat = false) => {
    const e = new Event(type); e.code = code; e.repeat = repeat; target.dispatchEvent(e);
  };
  fire('keydown', 'KeyE');
  assert.deepEqual(acts, [{ type: 'press', side: 'R', level: 'hi' }]); // same event, no charge wait
  t = 0.5;
  fire('keydown', 'KeyE', true); // repeat must not re-fire
  near(tr.state(t).heldSec, 0.5);
  fire('keydown', 'KeyX'); assert.equal(tr.state(t).side, 'R');
  assert.equal(acts.length, 1);
  fire('keyup', 'KeyQ'); assert.ok(tr.state(t)); // other key's keyup ignored
  assert.equal(acts.length, 1);
  fire('keyup', 'KeyE'); assert.equal(tr.state(t), null);
  assert.deepEqual(acts[1], { type: 'release', side: 'R', level: 'hi', heldSec: 0.5 });
  // Q and D held together: two presses; releasing Q lets go of L only
  fire('keydown', 'KeyQ'); fire('keydown', 'KeyD');
  assert.deepEqual(acts.slice(2), [{ type: 'press', side: 'L', level: 'hi' }, { type: 'press', side: 'R', level: 'mid' }]);
  fire('keyup', 'KeyQ');
  assert.deepEqual([acts.at(-1).type, acts.at(-1).side], ['release', 'L']);
  assert.ok(tr.state(t, 'R'));
  // same side: A replaces Q's slot, Q's keyup is then stale
  fire('keydown', 'KeyQ'); fire('keydown', 'KeyA'); const n0 = acts.length; fire('keyup', 'KeyQ');
  assert.equal(acts.length, n0);
  fire('keyup', 'KeyD'); assert.deepEqual([acts.at(-1).type, acts.at(-1).side], ['release', 'R']);
  fire('keyup', 'KeyA'); assert.deepEqual([acts.at(-1).type, acts.at(-1).side, acts.at(-1).level], ['release', 'L', 'mid']);
  fire('keydown', 'KeyZ'); fire('keydown', 'KeyC'); target.dispatchEvent(new Event('blur'));
  assert.equal(tr.state(t), null);
  assert.deepEqual(acts.at(-1), { type: 'release' });
  const n = acts.length;
  off(); fire('keydown', 'KeyQ'); assert.equal(tr.state(t), null);
  assert.equal(acts.length, n);
});

// main.js keeps its own Space/Enter listener for start/restart and drops onShot actions outside play,
// so on the title Space starts the game and the zip it also emits goes nowhere.
test('attachKeyboard: Space down/up = zip / zipEnd (repeat ignored), aim untouched; the start listener still sees Space', () => {
  const target = new EventTarget();
  const tr = createChargeTracker();
  const acts = [];
  let mode = 'title', starts = 0;
  attachKeyboard(target, tr, () => 0, (a) => { if (mode === 'play') acts.push(a); });
  target.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && mode === 'title') { starts++; mode = 'play'; } });
  const fire = (type, code, repeat = false) => { const e = new Event(type); e.code = code; e.repeat = repeat; target.dispatchEvent(e); };
  fire('keydown', 'Space'); fire('keyup', 'Space');
  assert.equal(starts, 1);
  assert.deepEqual(acts.map((a) => a.type), ['zipEnd']); // the title's zip was dropped; a stray zipEnd is harmless
  acts.length = 0;
  fire('keydown', 'KeyE'); fire('keydown', 'Space'); fire('keydown', 'Space', true); fire('keyup', 'Space');
  assert.deepEqual(acts.map((a) => a.type), ['press', 'zip', 'zipEnd']);
  assert.ok(tr.state(0), 'Space does not touch the aim');
  target.dispatchEvent(new Event('blur'));
  assert.deepEqual(acts.slice(-2).map((a) => a.type), ['zipEnd', 'release']);
});
