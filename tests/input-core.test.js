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

test('simultaneous: replacement restarts charge; stale release ignored', () => {
  const tr = createChargeTracker();
  tr.press('L', 'mid', 0); tr.press('R', 'lo', 0.2);
  assert.equal(tr.release('L', 'mid', 0.3), null);
  assert.equal(tr.state(0.3).side, 'R'); assert.equal(tr.state(0.3).level, 'lo');
  near(tr.release('R', 'lo', 0.5).heldSec, 0.3);
});

test('move keeps charge, release(null,null) fires current aim', () => {
  const tr = createChargeTracker();
  tr.press('R', 'mid', 0); tr.move('L', 'hi');
  near(tr.state(0.5).heldSec, 0.5);
  const r = tr.release(null, null, 0.6);
  assert.equal(r.side, 'L'); assert.equal(r.level, 'hi'); near(r.heldSec, 0.6);
  assert.equal(tr.release(null, null, 0.7), null);
});

test('cancel and no-aim cases', () => {
  const tr = createChargeTracker();
  assert.equal(tr.release('L', 'hi', 0), null);
  tr.move('L', 'hi'); // move without aim is a no-op
  assert.equal(tr.state(0), null);
  tr.press('L', 'hi', 0); tr.cancel();
  assert.equal(tr.release('L', 'hi', 1), null);
  assert.equal(tr.release(null, null, 1), null);
});

test('attachKeyboard: maps keys, ignores repeat/unknown, blur cancels, detach', () => {
  const target = new EventTarget();
  const tr = createChargeTracker();
  let t = 0;
  const off = attachKeyboard(target, tr, () => t);
  const fire = (type, code, repeat = false) => {
    const e = new Event(type); e.code = code; e.repeat = repeat; target.dispatchEvent(e);
  };
  fire('keydown', 'KeyE'); t = 0.5;
  fire('keydown', 'KeyE', true); // repeat must not restart
  near(tr.state(t).heldSec, 0.5);
  fire('keydown', 'KeyX'); assert.equal(tr.state(t).side, 'R');
  fire('keyup', 'KeyQ'); assert.ok(tr.state(t)); // other key's keyup ignored
  fire('keyup', 'KeyE'); assert.equal(tr.state(t), null);
  fire('keydown', 'KeyZ'); target.dispatchEvent(new Event('blur'));
  assert.equal(tr.state(t), null);
  off(); fire('keydown', 'KeyQ'); assert.equal(tr.state(t), null);
});
