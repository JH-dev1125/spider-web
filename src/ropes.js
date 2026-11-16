// Web ropes, one per hand: slot 'L' and slot 'R'. Each is a pull-only DistanceConstraint from a static anchor
// point to a point on any body (the hero sphere today, a ragdoll hand body later), with its own reel.
// All held ropes sit in the world together, so the solver combines their tensions; nothing here averages them.
// Releasing removes the constraint only: the body keeps the velocity the swing gave it.
import * as CANNON from '../vendor/cannon-es.js';
import { CFG } from './config.js';

export const SLOTS = ['L', 'R'];

// DistanceConstraint measures between body centres; this measures from body + localPivot (rotated) to the anchor.
// ContactEquation's error is n·(xj + rj - xi - ri), so ri = the pivot and rj = -distance·n make it |anchor - pivot| - distance.
function pivotUpdate(c, pivot) {
  return () => {
    const eq = c.distanceEquation;
    c.bodyA.quaternion.vmult(pivot, eq.ri);
    c.bodyB.position.vsub(c.bodyA.position, eq.ni); // cannon's vsub with a target returns nothing: no chaining
    eq.ni.vsub(eq.ri, eq.ni);
    eq.ni.normalize();
    eq.ni.scale(-c.distance, eq.rj);
  };
}

export function createRopes(world) {
  const slots = { L: null, R: null }; // {slot, at, anchor: Body, body, pivot, c, len, min, reelRate, seq}
  let seq = 0;
  const pivotWorld = (r) => r.body.pointToWorldFrame(r.pivot);
  const ropes = {
    slots,
    // anchorPoint {x,y,z}. Returns the rope, or null (keeping any held rope) when the anchor is too close to swing on.
    attach(slot, anchorPoint, body, localPivot = { x: 0, y: 0, z: 0 }) {
      const pivot = new CANNON.Vec3(localPivot.x, localPivot.y, localPivot.z);
      const at = { x: anchorPoint.x, y: anchorPoint.y, z: anchorPoint.z };
      const anchor = new CANNON.Body({ mass: 0, collisionFilterGroup: 0, collisionFilterMask: 0, position: new CANNON.Vec3(at.x, at.y, at.z) });
      const len = body.pointToWorldFrame(pivot).distanceTo(anchor.position);
      if (len < CFG.minRopeLen) return null;
      ropes.release(slot);
      const c = new CANNON.DistanceConstraint(body, anchor, len, CFG.ropeMaxForce);
      c.update = pivotUpdate(c, pivot);
      const eq = c.distanceEquation;
      eq.maxForce = 0; // a rope pulls, never pushes: slack when shorter than its length
      eq.setSpookParams(CFG.ropeStiffness, CFG.ropeRelaxation, CFG.physicsStep); // the default assumes a 1/60 s step
      world.addBody(anchor);
      world.addConstraint(c);
      // len: the full length, so attaching never yanks; reeling starts from here down to min
      return (slots[slot] = { slot, at, anchor, body, pivot, c, len, min: len * CFG.reelMinFactor, reelRate: 0, seq: ++seq });
    },
    // slot omitted / null = every rope. Returns how many let go.
    release(slot) {
      if (slot == null) return SLOTS.reduce((n, s) => n + ropes.release(s), 0);
      const r = slots[slot];
      if (!r) return 0;
      world.removeConstraint(r.c);
      world.removeBody(r.anchor);
      slots[slot] = null;
      return 1;
    },
    // Before each world.step(h): take up slack (no force, never moves the body), reel in under tension.
    stepReel(h) {
      for (const r of ropes.active()) {
        const d = pivotWorld(r).distanceTo(r.anchor.position);
        r.reelRate = d >= r.len - 1e-3 ? Math.min(CFG.reelSpeed, r.reelRate + CFG.reelAccel * h) : 0; // spins up, stops when slack
        if (d < r.len) r.len = Math.max(CFG.minRopeLen, d);
        if (r.len > r.min) r.len = Math.max(r.min, r.len - r.reelRate * h);
        r.c.distance = r.len;
      }
    },
    // Newtons the rope pulled with in the last solve (the equation's multiplier is lambda / dt; pulling is negative).
    tension(slot) { const r = slots[slot]; return r ? Math.max(0, -r.c.distanceEquation.multiplier) : 0; },
    active: () => SLOTS.map((s) => slots[s]).filter(Boolean),
    latest: () => ropes.active().reduce((a, r) => (!a || r.seq > a.seq ? r : a), null),
    // For the view: [{slot, anchor, len, tension}]. anchor keeps its identity for the rope's lifetime.
    view: () => ropes.active().map((r) => ({ slot: r.slot, anchor: r.at, len: r.len, tension: ropes.tension(r.slot) })),
  };
  return ropes;
}
