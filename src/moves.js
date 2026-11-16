import { Quaternion, Vec3 } from '../vendor/cannon-es.js';
import { CFG } from './config.js';

// +y up, +z forward. Public keyframes contain basis-relative Euler radians, YZX
// (Cannon's native toEuler order), NOT parent-relative joint angles.
const PARENTS = { pelvis: null, chest: 'pelvis', head: 'chest' };
for (const s of ['L', 'R']) {
  Object.assign(PARENTS, { ['upperArm' + s]: 'chest', ['forearm' + s]: 'upperArm' + s,
    ['hand' + s]: 'forearm' + s, ['thigh' + s]: 'pelvis', ['shin' + s]: 'thigh' + s, ['foot' + s]: 'shin' + s });
}
const quat = e => new Quaternion().setFromEuler(...e, 'YZX');

// Author in joint space once; publish complete orientations in the basis frame.
function pose(joints = {}) {
  const q = {}, targets = {};
  for (const [name, parent] of Object.entries(PARENTS)) {
    const local = quat(joints[name] || (name.startsWith('shin') ? [.08, 0, 0] : [0, 0, 0]));
    q[name] = parent ? q[parent].mult(local) : local;
    const e = new Vec3(); q[name].toEuler(e, 'YZX'); targets[name] = e.toArray();
  }
  return targets;
}

const idle = pose({ forearmL: [-.12, 0, 0], forearmR: [-.12, 0, 0] });
const glide = pose({ chest: [.12, 0, 0], head: [-.16, 0, 0],
  upperArmL: [-.2, 0, -1.3], upperArmR: [-.2, 0, 1.3],
  forearmL: [-.25, 0, 0], forearmR: [-.25, 0, 0],
  thighL: [-.15, 0, -.18], thighR: [-.15, 0, .18], shinL: [.3, 0, 0], shinR: [.3, 0, 0] });
const tight = pose({ chest: [.25, 0, 0], head: [.3, 0, 0],
  upperArmL: [-.9, 0, -.1], upperArmR: [-.9, 0, .1],
  forearmL: [-1.8, 0, 0], forearmR: [-1.8, 0, 0],
  thighL: [-1.65, 0, -.1], thighR: [-1.65, 0, .1], shinL: [2.3, 0, 0], shinR: [2.3, 0, 0] });
const stretched = pose({ chest: [-.18, 0, 0], head: [-.1, 0, 0],
  upperArmL: [.15, 0, -.13], upperArmR: [.15, 0, .13],
  forearmL: [-.25, 0, 0], forearmR: [-.25, 0, 0], thighL: [.15, 0, 0], thighR: [.15, 0, 0] });
const reach = pose({ chest: [.12, 0, 0], head: [.35, 0, 0],
  upperArmL: [-2.65, 0, -.12], upperArmR: [-2.7, 0, .12],
  forearmL: [-.6, 0, 0], forearmR: [-.45, 0, 0],
  thighL: [-.3, 0, -.08], thighR: [-.3, 0, .08], shinL: [.5, 0, 0], shinR: [.5, 0, 0] });
const strain = pose({ chest: [.32, 0, 0], head: [.45, 0, 0],
  upperArmL: [-2.8, 0, -.08], upperArmR: [-2.82, 0, .08],
  forearmL: [-.06, 0, 0], forearmR: [-.04, 0, 0],
  thighL: [-.6, 0, -.08], thighR: [-.6, 0, .08], shinL: [.95, 0, 0], shinR: [.95, 0, 0] });
const landingJoints = { chest: [.43, 0, 0], head: [.12, 0, 0],
  upperArmL: [-.43, 0, 0], forearmL: [-.05, 0, 0],
  upperArmR: [.6, 0, 1], forearmR: [-.65, 0, 0],
  thighL: [1.08, 0, 0], shinL: [1.05, 0, 0], footL: [-.55, 0, 0],
  thighR: [-1.89, 0, 0], shinR: [2.5, 0, 0], footR: [-.61, 0, 0] };

function move(name, frames, options = {}) {
  const trick = Object.hasOwn(CFG.moves.weights, name);
  return { name, trick, duration: frames.at(-1)[0], minAirtime: 0,
    weight: CFG.moves.weights[name] || 0, cancelOnPress: trick, impulses: [],
    ...options, keyframes: frames.map(([time, targets]) => ({ time, targets })) };
}

// Impulses are ONE-SHOT events: linear = whole-body delta-v (m/s), angular =
// whole-body angular impulse (N m s); both vectors are in the launch basis frame.
export const MOVES = {
  corkscrew: move('corkscrew', [[0, glide], [.16, stretched], [.7, stretched], [.95, glide]],
    { minAirtime: 1.2, impulses: [{ time: .1, angular: [0, 95, 0] }] }),
  frontHalfTwist: move('frontHalfTwist', [[0, glide], [.18, tight], [.65, tight], [.95, glide]],
    { minAirtime: 1.3, impulses: [{ time: .1, angular: [-85, 0, 0] }, { time: .36, angular: [0, 38, 0] }] }),
  layoutBackflip: move('layoutBackflip', [[0, glide], [.2, pose({ chest: [-.2, 0, 0],
    upperArmL: [-.3, 0, -1.3], upperArmR: [-.3, 0, 1.3], thighL: [.15, 0, 0], thighR: [.15, 0, 0] })], [1.05, glide]],
    { minAirtime: 1.4, impulses: [{ time: .1, angular: [100, 0, 0] }] }),
  swanDive: move('swanDive', [[0, glide], [.22, pose({ pelvis: [1.15, 0, 0], chest: [-.3, 0, 0], head: [-.2, 0, 0],
    upperArmL: [.65, 0, -.55], upperArmR: [.65, 0, .55], thighL: [.25, 0, -.1], thighR: [.25, 0, .1] })], [.7, stretched], [.9, glide]],
    { minAirtime: 1.1 }),
  superheroDive: move('superheroDive', [[0, glide], [.18, pose({ pelvis: [1.15, 0, 0], chest: [-.2, 0, 0], head: [-.2, 0, 0],
    upperArmL: [.65, 0, -.3], upperArmR: [-2.3, 0, .12], forearmL: [-.8, 0, 0], forearmR: [-.1, 0, 0],
    thighL: [-.5, 0, 0], shinL: [1, 0, 0], thighR: [.2, 0, 0] })], [.65, glide]], { minAirtime: .85 }),
  splitKick: move('splitKick', [[0, tight], [.2, pose({ chest: [.1, 0, 0],
    upperArmL: [0, 0, -1.25], upperArmR: [0, 0, 1.25],
    thighL: [-.35, 0, -1.5], thighR: [-.35, 0, 1.5] })], [.36, stretched], [.65, glide]], { minAirtime: .85 }),
  tuckBurst: move('tuckBurst', [[0, glide], [.14, tight], [.5, tight], [.64, glide], [.85, glide]],
    { minAirtime: 1.1, impulses: [{ time: .12, angular: [0, 55, 0] }] }),
  thwip: move('thwip', [[0, glide], [.2, pose({ chest: [.3, 0, 0], head: [.1, 0, 0],
    upperArmL: [-.2, 0, 0], forearmL: [-.5, 0, 0], handL: [.25, 0, 0],
    upperArmR: [-.6, 0, 1.3], forearmR: [-.8, 0, 0], handR: [-.25, 0, 0],
    thighL: [-1.55, 0, -.5], thighR: [-1.55, 0, .5], shinL: [2.2, 0, 0], shinR: [2.2, 0, 0] })], [.8, glide]], { minAirtime: 1 }),
  spreadEagle: move('spreadEagle', [[0, glide], [.3, pose({ chest: [-.2, 0, 0], head: [-.15, 0, 0],
    upperArmL: [.15, 0, -1.4], upperArmR: [-.15, 0, 1.4], thighL: [0, 0, -.7], thighR: [0, 0, .7] })],
  [.65, pose({ chest: [-.15, 0, .07], upperArmL: [-.15, 0, -1.3], upperArmR: [.15, 0, 1.3],
    thighL: [.1, 0, -.7], thighR: [-.1, 0, .7] })], [1, glide], [1.3, glide]], { minAirtime: 2.4 }),
  slingshotWhip: move('slingshotWhip', [[0, reach], [.14, tight], [.3, stretched], [.65, glide]],
    { minAirtime: .85, impulses: [{ time: .18, angular: [-22, 0, 0] }] }),

  glide: move('glide', [[0, glide], [.3, glide]]),
  preland: move('preland', [[0, glide], [.3, pose({ chest: [.08, 0, 0], head: [.22, 0, 0],
    upperArmL: [-.2, 0, -.2], upperArmR: [.25, 0, .5], forearmL: [-.1, 0, 0], forearmR: [-.5, 0, 0],
    thighL: [.15, 0, 0], thighR: [-.3, 0, 0], shinL: [.12, 0, 0], shinR: [.4, 0, 0] })]]),
  landing: move('landing', [[0, idle], [.18, pose(landingJoints)], [.55, pose(landingJoints)],
    [1, pose({ ...landingJoints, head: [-.22, 0, 0] })]]),
  roofIdle: move('roofIdle', [[0, idle], [1.5, pose({ chest: [-.025, 0, .025], head: [.04, 0, 0],
    upperArmL: [.04, 0, -.05], upperArmR: [-.04, 0, .05], forearmL: [-.12, 0, 0], forearmR: [-.12, 0, 0] })], [3, idle]]),
  roofTumble: move('roofTumble', [[0, idle], [.12, tight], [.65, tight], [1, glide]],
    { impulses: [{ time: 0, linear: [0, 3.5, -5], angular: [100, 0, 0] }] }),
  swingReach: move('swingReach', [[0, glide], [.25, reach]]),
  swingStrain: move('swingStrain', [[0, reach], [.25, strain]]),
  release: move('release', [[0, reach], [.06, pose({ upperArmL: [.2, 0, -.8],
    upperArmR: [-2.7, 0, .12], forearmR: [-.45, 0, 0] })], [.18, glide]]),
  zipYank: move('zipYank', [[0, strain], [.06, pose({ chest: [.4, 0, 0], head: [.3, 0, 0],
    upperArmL: [-1, 0, -.1], upperArmR: [-1, 0, .1], forearmL: [-2.1, 0, 0], forearmR: [-2.1, 0, 0],
    thighL: [-.6, 0, 0], thighR: [-.6, 0, 0], shinL: [1, 0, 0], shinR: [1, 0, 0] })], [.16, stretched], [.4, glide]]),
};

// `last` may be the returned move or its name; null means glide (no eligible trick).
export function pickTrick(rng, last, airtimeLeft) {
  const name = typeof last === 'string' ? last : last?.name;
  const eligible = Object.values(MOVES).filter(m => m.trick && m.name !== name && m.minAirtime <= airtimeLeft && m.weight > 0);
  const total = eligible.reduce((sum, m) => sum + m.weight, 0);
  if (!total) return null;
  let draw = rng() * total;
  for (const m of eligible) { draw -= m.weight; if (draw < 0) return m; }
  return eligible.at(-1);
}

export function sampleMove(move, tSec, basisQuat, outTargets) {
  const frames = move.keyframes;
  const t = Math.max(0, Math.min(move.duration, tSec));
  let i = 0;
  while (i < frames.length - 2 && t > frames[i + 1].time) i++;
  const a = frames[i], b = frames[i + 1], u = (t - a.time) / (b.time - a.time);
  // Slerp relative joints, then compose world targets: independent world slerps
  // would introduce off-axis elbow/knee rotations between otherwise valid keys.
  for (const [name, parent] of Object.entries(PARENTS)) {
    let qa = quat(a.targets[name]), qb = quat(b.targets[name]);
    if (parent) {
      qa = quat(a.targets[parent]).conjugate().mult(qa);
      qb = quat(b.targets[parent]).conjugate().mult(qb);
    }
    const out = outTargets[name] ||= new Quaternion();
    (parent ? outTargets[parent] : basisQuat).mult(qa.slerp(qb, u), out);
    out.normalize();
  }
  return outTargets;
}

export function moveImpulses(move, t0, t1) {
  return move.impulses.filter(i => i.time > t0 && i.time <= t1);
}
