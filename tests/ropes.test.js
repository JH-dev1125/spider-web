import test from 'node:test';
import assert from 'node:assert/strict';
import * as CANNON from '../vendor/cannon-es.js';
import { CFG } from '../src/config.js';
import { createRopes } from '../src/ropes.js';
import { createGame, stepGame } from '../src/game.js';

// Swings a spinning box on a rope tied at `tie` (body-local); returns how far the point `probe` got past the rope length.
function swing(tie, probe) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -CFG.gravity, 0) });
  const body = new CANNON.Body({ mass: 1, shape: new CANNON.Box(new CANNON.Vec3(0.2, 0.5, 0.2)), position: new CANNON.Vec3(0, 20, 0) });
  body.angularVelocity.set(0, 0, 3);
  world.addBody(body);
  const ropes = createRopes(world);
  const r = ropes.attach('L', { x: 6, y: 30, z: 0 }, body, tie);
  const len0 = r.len;
  let maxOver = 0;
  for (let i = 0; i < 240; i++) {
    ropes.stepReel(CFG.physicsStep);
    world.step(CFG.physicsStep);
    const p = body.pointToWorldFrame(new CANNON.Vec3(probe.x, probe.y, probe.z));
    maxOver = Math.max(maxOver, p.distanceTo(r.anchor.position) - r.len);
  }
  return { maxOver, world, ropes, r, len0 };
}

test('ropes: a rope on a body pivot holds that point (not the centre) within its length, on a spinning body', () => {
  const pivot = { x: 0, y: 0.5, z: 0 };
  const { maxOver, world, ropes, r, len0 } = swing(pivot, pivot);
  assert.ok(maxOver < 0.1, `pivot drifted ${maxOver.toFixed(3)} m past the rope`);
  assert.ok(swing({ x: 0, y: 0, z: 0 }, pivot).maxOver > 0.3, 'control: tied at the centre, that point does stray');
  assert.ok(r.len < len0, 'reeled in');
  assert.ok(ropes.tension('L') > 0);
  assert.equal(ropes.release(), 1);
  assert.equal(world.constraints.length, 0);
  assert.deepEqual(ropes.view(), []);
});

test('ropes: too short keeps the held rope; slots are independent', () => {
  const world = new CANNON.World();
  const body = new CANNON.Body({ mass: 1, shape: new CANNON.Sphere(0.4) });
  world.addBody(body);
  const ropes = createRopes(world);
  const a = ropes.attach('R', { x: 0, y: 20, z: 0 }, body);
  assert.equal(ropes.attach('R', { x: 0, y: 0.5, z: 0 }, body), null);
  assert.equal(ropes.slots.R, a);
  ropes.attach('L', { x: 0, y: 25, z: 5 }, body);
  assert.deepEqual(ropes.view().map((v) => v.slot), ['L', 'R']);
  assert.equal(ropes.latest().slot, 'L');
  assert.equal(ropes.release('R'), 1);
  assert.deepEqual(ropes.view().map((v) => v.slot), ['L']);
});

test('overhead (side C, the W key) fires from a free hand, else replaces the older rope; its release finds that slot', () => {
  const g = createGame(1);
  const press = (side) => stepGame(g, 1 / 60, [{ type: 'press', side, level: 'hi' }]);
  const flying = () => Object.keys(g.webs).filter((s) => g.webs[s]);
  press('C');
  assert.deepEqual(flying(), ['L'], 'both free: the first free hand');
  press('R');
  press('C');
  assert.deepEqual(flying(), ['L', 'R'], 'both busy: replaces L, pressed longer ago');
  assert.equal(g.cSlot, 'L');
  stepGame(g, 1 / 60, [{ type: 'release', side: 'C' }]);
  assert.deepEqual(flying(), ['R']);
});
