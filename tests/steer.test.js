import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { steerAccel } from '../src/steer.js';
import { swingMetrics } from './swing-metrics.js';

const H = { x: 0, z: 1 };

test('steer turns the horizontal velocity toward the heading, capped, and never adds speed', () => {
  for (const v0 of [{ x: 8, y: -3, z: 12 }, { x: -15, y: 4, z: 5 }, { x: 30, y: 0, z: 1 }, { x: 0.5, y: -9, z: 20 }]) {
    const v = { ...v0 }, h = CFG.physicsStep;
    let sp = Math.hypot(v.x, v.y, v.z);
    const ang0 = Math.abs(Math.atan2(v.x, v.z));
    for (let i = 0; i < 600; i++) { // 5 s of steering alone, integrated like cannon (semi-implicit Euler)
      const a = steerAccel(v, H);
      assert.ok(Math.hypot(a.x, a.y, a.z) <= CFG.steer.maxAccel + 1e-9);
      v.x += a.x * h; v.z += a.z * h;
      const s = Math.hypot(v.x, v.y, v.z);
      assert.ok(s <= sp + 1e-12, `speed rose ${sp} -> ${s}`);
      sp = s;
    }
    assert.ok(Math.abs(Math.atan2(v.x, v.z)) < ang0, 'turned toward the heading');
  }
  assert.deepEqual(steerAccel({ x: 0, y: -5, z: 0 }, H), { x: 0, y: 0, z: 0 });
  // already along the street: nothing to do
  const a = steerAccel({ x: 0, y: 2, z: 20 }, H);
  assert.ok(Math.abs(a.x) < 1e-12 && Math.abs(a.z) < 1e-12);
});

// The user's complaint: every swing ran into the wall the web was on. Webs go high and the body steers, so the
// bot (typical press / hold / release) swings forward. Before this change: 11.8 m sideways, 23 m forward, 2.5 contacts/10 s.
test('swings carry him forward: seeds 1-40, small sideways excursion, long forward progress, rare wall contacts', () => {
  const m = swingMetrics(Array.from({ length: 40 }, (_, i) => i + 1));
  assert.ok(m.medianSide < 8, `median sideways ${m.medianSide.toFixed(1)} m`);
  assert.ok(m.medianForward >= 25, `median forward ${m.medianForward.toFixed(1)} m`);
  assert.ok(m.contactsPer10s < 1, `${m.contactsPer10s.toFixed(2)} wall contacts per 10 s`);
  assert.ok(m.survived >= 36, `${m.survived}/40 survived 30 s`);
});
