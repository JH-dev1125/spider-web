import { Vec3 } from '../vendor/cannon-es.js';

// Pure additive delta-v; the caller owns attachment, cooldown and impulse delivery.
export function zipLaunch(vel, heading, ropeDir, cfg) {
  const vectors = [vel, heading, ropeDir];
  if (!vectors.every(v => v && [v.x, v.y, v.z].every(Number.isFinite)) ||
      !Number.isFinite(cfg.zipLaunch) || cfg.zipLaunch < 0 ||
      !Number.isFinite(cfg.zipRopeBias) || cfg.zipRopeBias < 0 || cfg.zipRopeBias > .6) {
    throw new RangeError('zipLaunch requires finite vectors, nonnegative speed and rope bias in [0, .6]');
  }
  const forward = new Vec3(heading.x, 0, heading.z);
  if (forward.lengthSquared() < 1e-12) forward.set(vel.x, 0, vel.z);
  if (forward.lengthSquared() < 1e-12) forward.set(0, 0, 1);
  forward.normalize();
  const rope = new Vec3(ropeDir.x, ropeDir.y, ropeDir.z); rope.normalize();
  const dir = forward.vadd(rope.scale(cfg.zipRopeBias));
  dir.y = Math.max(0, dir.y);
  // Bias .6 can turn more than 30 degrees with a low, sideways anchor.
  const along = dir.dot(forward), side = new Vec3(forward.z, 0, -forward.x);
  const lateral = Math.max(-along / Math.sqrt(3), Math.min(along / Math.sqrt(3), dir.dot(side)));
  dir.x = forward.x * along + side.x * lateral;
  dir.z = forward.z * along + side.z * lateral;
  dir.normalize();
  return { dv: { x: dir.x * cfg.zipLaunch, y: dir.y * cfg.zipLaunch, z: dir.z * cfg.zipLaunch },
    dir: { x: dir.x, y: dir.y, z: dir.z } };
}
