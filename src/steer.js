// Body English on the rope: the swinger leans and pulls, which turns the swing plane toward where he is heading.
// Pure: returns an acceleration (m/s^2, horizontal) to apply to the body (sphere now, the ragdoll's pelvis later;
// multiply by its mass for a force). Two parts, neither of which adds speed:
//   turn — perpendicular to the horizontal velocity, toward `heading`: rotates the velocity, does no work;
//   damp — against the velocity across `heading`: only ever removes energy, and outweighs the integrator's
//          second-order gain from the turn, so speed never grows step to step.
// heading: unit horizontal {x, z} (the street direction).
import { CFG } from './config.js';

export function steerAccel(vel, heading) {
  const S = CFG.steer;
  const sp = Math.hypot(vel.x, vel.z);
  if (sp < 1e-6) return { x: 0, y: 0, z: 0 };
  const ux = vel.x / sp, uz = vel.z / sp;
  const along = heading.x * ux + heading.z * uz;
  // heading's part perpendicular to the velocity: points the way to turn, length = sin(angle off heading)
  let ax = S.turn * sp * (heading.x - along * ux), az = S.turn * sp * (heading.z - along * uz);
  if (along < 0) { ax = 0; az = 0; } // moving backward along the street: no turn (a U-turn is not body English)
  const lat = vel.x * heading.z - vel.z * heading.x; // velocity along (heading.z, -heading.x), across the street
  ax -= S.damp * lat * heading.z;
  az += S.damp * lat * heading.x;
  const a = Math.hypot(ax, az), k = a > S.maxAccel ? S.maxAccel / a : 1;
  return { x: ax * k, y: 0, z: az * k };
}
