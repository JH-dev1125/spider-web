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

// Flight links end in their own silhouette; the next link blends directly out
// of it rather than returning to spread-eagle between every move.
function flight(name, frames, options = {}) {
  return move(name, frames, { weight: 1, cancelOnPress: true, ...options });
}
const pencil = pose({ pelvis: [.65, 0, 0], chest: [-.12, 0, 0], head: [-.2, 0, 0],
  upperArmL: [.15, 0, -.2], upperArmR: [.15, 0, .2], handL: [.25, 0, 0], handR: [.25, 0, 0],
  footL: [.3, 0, 0], footR: [.3, 0, 0] });
const arabesque = pose({ pelvis: [.3, 0, 0], chest: [-.18, 0, 0],
  upperArmL: [-2.5, 0, -.35], upperArmR: [-.5, 0, 1.5], forearmL: [-.35, 0, 0], forearmR: [-.3, 0, 0],
  thighL: [1.2, 0, -.12], thighR: [-.2, 0, .12], shinR: [.55, 0, 0], footL: [.4, 0, 0], footR: [.4, 0, 0] });
const attitude = pose({ chest: [-.1, 0, .1], head: [0, .25, 0],
  upperArmL: [-2.5, 0, -.35], upperArmR: [-1, 0, 1.4], forearmL: [-.4, 0, 0],
  thighL: [-.65, 0, -1.1], shinL: [1.7, 0, 0], footR: [.4, 0, 0] });
const surfer = pose({ pelvis: [0, .9, .28], chest: [.12, -.3, 0], head: [0, -.4, 0],
  upperArmL: [-.4, 0, -1.5], upperArmR: [.4, 0, 1.3], forearmL: [-.4, 0, 0], forearmR: [-.65, 0, 0],
  thighL: [-.9, 0, -.25], thighR: [-.65, 0, .25], shinL: [1.3, 0, 0], shinR: [1.05, 0, 0] });
const lounge = pose({ pelvis: [-1.15, 0, 0], chest: [-.15, 0, 0], head: [.3, 0, 0],
  upperArmL: [-2.1, 0, -.7], upperArmR: [-2.1, 0, .7], forearmL: [-2.1, 0, 0], forearmR: [-2.1, 0, 0],
  thighL: [.15, .15, .2], thighR: [-.1, -.15, -.16], shinL: [.35, 0, 0], shinR: [.55, 0, 0] });
const kick = sign => pose({ pelvis: [.65, 0, 0], chest: [-.15, 0, 0],
  upperArmL: [.55, 0, -.25], upperArmR: [.55, 0, .25],
  thighL: [-.35 + sign * .55, 0, -.08], thighR: [-.35 - sign * .55, 0, .08],
  shinL: [.25, 0, 0], shinR: [.25, 0, 0] });
const twistDive = pose({ chest: [.15, 0, 0], head: [-.25, 0, 0],
  upperArmL: [-.65, 0, -.25], upperArmR: [-.65, 0, .25], forearmL: [-2.3, 0, 0], forearmR: [-2.3, 0, 0],
  thighL: [.15, 0, -.06], thighR: [.15, 0, .06], footL: [.3, 0, 0], footR: [.3, 0, 0] });
const runner = sign => pose({ chest: [.3, 0, 0], head: [-.2, 0, 0],
  upperArmL: [sign * .8, 0, -.1], upperArmR: [-sign * .8, 0, .1],
  forearmL: [-1.3, 0, 0], forearmR: [-1.3, 0, 0],
  thighL: [-.3 - sign * .95, 0, 0], thighR: [-.3 + sign * .95, 0, 0],
  shinL: [sign > 0 ? .65 : 2, 0, 0], shinR: [sign > 0 ? 2 : .65, 0, 0] });
const pike = pose({ chest: [.35, 0, 0], head: [.2, 0, 0],
  upperArmL: [-1.5, 0, -.12], upperArmR: [-1.5, 0, .12], forearmL: [-.15, 0, 0], forearmR: [-.15, 0, 0],
  thighL: [-1.75, 0, -.05], thighR: [-1.75, 0, .05], shinL: [.12, 0, 0], shinR: [.12, 0, 0] });
const saddle = pose({ pelvis: [0, .25, -.35], chest: [.05, 0, .2], head: [0, .2, 0],
  upperArmL: [-.1, 0, -.2], upperArmR: [-2.6, 0, .25], forearmL: [-.2, 0, 0],
  thighL: [-.55, 0, -.65], thighR: [-.55, 0, -.65], shinL: [.6, 0, 0], shinR: [.6, 0, 0] });
const thinker = pose({ chest: [.35, 0, 0], head: [.35, -.25, 0],
  upperArmL: [-.65, 0, -.1], upperArmR: [-.45, 0, .4], forearmL: [-2.35, 0, 0], forearmR: [-1.5, 0, 0],
  handL: [.2, 0, 0], thighL: [-1.5, 0, -.25], thighR: [-1.2, 0, .25], shinL: [2.2, 0, 0], shinR: [1.8, 0, 0] });
const superman = pose({ pelvis: [1.25, 0, 0], chest: [-.2, 0, 0], head: [-.3, 0, 0],
  upperArmL: [.3, 0, -.12], upperArmR: [-2.65, 0, .1], forearmL: [-.15, 0, 0], forearmR: [-.1, 0, 0],
  thighL: [.2, 0, 0], thighR: [.2, 0, 0], footL: [.35, 0, 0], footR: [.35, 0, 0] });
const peek = pose({ chest: [-.25, 0, 0], head: [-.4, 0, 0],
  upperArmL: [-1.6, 0, -.5], upperArmR: [-1.6, 0, .5], forearmL: [-2, 0, 0], forearmR: [-2, 0, 0],
  thighL: [-.7, 0, -.1], thighR: [-.7, 0, .1], shinL: [1.4, 0, 0], shinR: [1.4, 0, 0] });

export const FLIGHT = {
  ...Object.fromEntries(Object.values(MOVES).filter(m => m.trick).map(m => [m.name, m])),
  frontRolls: flight('frontRolls', [[0, tight], [.4, tight], [.5, pike], [.6, tight], [.95, tight], [1.05, pike], [1.15, tight], [1.4, tight]],
    { minAirtime: 2.1, impulses: [{ time: .03, angular: [-84, 0, 0] }, { time: .43, angular: [-84, 0, 0] }, { time: .83, angular: [-84, 0, 0] }] }),
  pencilDive: flight('pencilDive', [[0, pencil], [.55, pose({ pelvis: [.85, 0, 0], chest: [-.1, 0, 0], head: [-.25, 0, 0],
    upperArmL: [.2, 0, -.15], upperArmR: [.2, 0, .15], handL: [.25, 0, 0], handR: [.25, 0, 0], footL: [.35, 0, 0], footR: [.35, 0, 0] })], [1.1, pencil]]),
  arabesque: flight('arabesque', [[0, arabesque], [.65, pose({ chest: [-.12, 0, 0],
    upperArmL: [-2.6, 0, -.25], upperArmR: [-.65, 0, 1.5], forearmL: [-.35, 0, 0],
    thighL: [1.3, 0, -.1], thighR: [-.3, 0, .1], shinR: [.65, 0, 0], footL: [.4, 0, 0], footR: [.4, 0, 0] })], [1.3, arabesque]]),
  attitudeTurn: flight('attitudeTurn', [[0, attitude], [.6, attitude], [1.2, arabesque]],
    { impulses: [{ time: .08, angular: [0, 18, 0] }] }),
  skySurfer: flight('skySurfer', [[0, surfer], [.55, pose({ pelvis: [0, 1.1, -.2], chest: [.2, -.3, 0],
    upperArmL: [.3, 0, -1.3], upperArmR: [-.4, 0, 1.5], forearmL: [-.6, 0, 0],
    thighL: [-.6, 0, -.25], thighR: [-1, 0, .25], shinL: [1, 0, 0], shinR: [1.4, 0, 0] })], [1.1, surfer]]),
  cannonball: flight('cannonball', [[0, tight], [.6, pose({ chest: [.35, 0, 0], head: [.4, 0, 0],
    upperArmL: [-1.15, 0, -.15], upperArmR: [-1.15, 0, .15], forearmL: [-2, 0, 0], forearmR: [-2, 0, 0],
    thighL: [-1.8, 0, -.1], thighR: [-1.8, 0, .1], shinL: [2.45, 0, 0], shinR: [2.45, 0, 0] })], [1.2, tight]],
    { impulses: [{ time: .05, angular: [16, 0, 7] }] }),
  cityLounge: flight('cityLounge', [[0, lounge], [.6, lounge], [1.2, pose({ pelvis: [-1.2, 0, .1], head: [.25, .35, 0],
    upperArmL: [-2.1, 0, -.7], upperArmR: [-2.1, 0, .7], forearmL: [-2.1, 0, 0], forearmR: [-2.1, 0, 0],
    thighL: [.15, .15, .2], thighR: [-.1, -.15, -.16], shinL: [.35, 0, 0], shinR: [.55, 0, 0] })]]),
  scissorKicks: flight('scissorKicks', [[0, kick(1)], [.2, kick(-1)], [.4, kick(1)], [.6, kick(-1)], [.8, kick(1)], [1, kick(-1)]]),
  twistingDive: flight('twistingDive', [[0, twistDive], [.5, twistDive], [1.1, stretched]],
    { impulses: [{ time: .06, angular: [0, 12, 22] }] }),
  airRun: flight('airRun', [[0, runner(1)], [.18, runner(-1)], [.36, runner(1)], [.54, runner(-1)], [.72, runner(1)], [.9, runner(-1)], [1.08, runner(1)]]),
  starPike: flight('starPike', [[0, glide], [.3, pike], [.55, pike], [.85, glide], [1.2, pike]]),
  sideSaddle: flight('sideSaddle', [[0, saddle], [.55, saddle], [1.1, pose({ pelvis: [0, .45, -.25], chest: [.1, 0, .15],
    upperArmL: [-.2, 0, -.3], upperArmR: [-2.4, 0, .45], thighL: [-.65, 0, -.75], thighR: [-.65, 0, -.75],
    shinL: [.45, 0, 0], shinR: [.45, 0, 0] })]]),
  thinker: flight('thinker', [[0, thinker], [.6, thinker], [1.2, thinker]],
    { impulses: [{ time: .08, angular: [0, 10, 0] }] }),
  superman: flight('superman', [[0, superman], [.5, superman], [1, pencil]]),
  corkscrewLayout: flight('corkscrewLayout', [[0, twistDive], [.3, tight], [.6, stretched], [1.25, stretched]],
    { minAirtime: 1.9, impulses: [{ time: .05, angular: [0, 24, 0] }, { time: .6, angular: [18, 0, 0] }] }),
  peekaboo: flight('peekaboo', [[0, peek], [.45, peek], [.7, tight], [1.2, stretched]],
    { minAirtime: 1.9, impulses: [{ time: .04, angular: [24, 0, 0] }, { time: .65, angular: [-32, 0, 0] }] }),
};

const DIVE = new Set(['pencilDive', 'superman', 'twistingDive', 'corkscrew', 'corkscrewLayout', 'swanDive', 'superheroDive']);
const APEX = new Set(['arabesque', 'attitudeTurn', 'thinker', 'cityLounge']);
const flightAir = m => Math.max(m.minAirtime, m.duration / .8 + .3);

// `last` accepts a move/name or the caller's recent-history array (oldest first).
export function pickFlight(rng, last, airtimeLeft, speed, vy) {
  const recent = (Array.isArray(last) ? last.slice(-3) : [last]).map(m => typeof m === 'string' ? m : m?.name);
  const diving = speed >= 22 && vy < -4, apex = speed < 18 && Math.abs(vy) < 4;
  const choices = Object.values(FLIGHT).filter(m => !recent.includes(m.name) && flightAir(m) <= airtimeLeft);
  const weights = choices.map(m => m.weight * (diving && DIVE.has(m.name) || apex && APEX.has(m.name) ? 5 : 1));
  let draw = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < choices.length; i++) { draw -= weights[i]; if (draw < 0) return choices[i]; }
  return choices.at(-1) || null;
}

export function createFlightChain(rng) {
  const history = [];
  let current = null, blendSec = 0;
  return {
    step(dt, ctx) {
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError('flight dt must be finite and nonnegative');
      const { airborne, rope, pressed, preland, airtimeLeft, speed, vy } = ctx;
      if (!airborne || rope || pressed || preland || !(airtimeLeft > .3)
        || current && (current.move.duration - current.t) / current.rate + .3 > airtimeLeft) {
        current = null;
        return { move: null, t: 0, mirror: 1, rate: 1, t0: 0, blend: 0, started: false };
      }
      let started = false;
      if (!current || current.t >= current.move.duration) {
        const next = pickFlight(rng, history, airtimeLeft, speed, vy);
        if (!next) { current = null; return { move: null, t: 0, mirror: 1, rate: 1, t0: 0, blend: 0, started: false }; }
        // Short legacy tricks cannot speed up by 10% and still last .6 seconds.
        const slow = rng() < .5 || next.duration / 1.1 < .6;
        current = { move: next, t: 0, mirror: rng() < .5 ? -1 : 1, rate: slow ? .8 + rng() * .1 : 1.1 + rng() * .1 };
        history.push(next.name); if (history.length > 3) history.shift();
        blendSec = 0; started = true;
      }
      current.t0 = started ? -Number.EPSILON : current.t;
      current.t = Math.min(current.move.duration, current.t + dt * current.rate);
      blendSec += dt;
      current.blend = Math.min(1, blendSec / .25);
      current.started = started;
      return current;
    },
  };
}

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

// Swing rotation vectors form a convex cone-limit ball; quaternion slerp can
// take a shortcut outside it. Interpolate twist separately about joint +y.
function blendJoint(a, b, u) {
  const split = q => {
    const twist = new Quaternion(0, q.y, 0, q.w); twist.normalize();
    if (twist.w < 0) { twist.y *= -1; twist.w *= -1; }
    const swing = q.mult(twist.conjugate());
    if (swing.w < 0) { swing.x *= -1; swing.z *= -1; swing.w *= -1; }
    const n = Math.hypot(swing.x, swing.z), k = n > 1e-12 ? 2 * Math.atan2(n, swing.w) / n : 0;
    return [swing.x * k, swing.z * k, 2 * Math.atan2(twist.y, twist.w)];
  };
  const x = split(a), y = split(b), v = x.map((n, i) => n + (y[i] - n) * u);
  const angle = Math.hypot(v[0], v[1]);
  const swing = angle > 1e-12 ? new Quaternion().setFromAxisAngle(new Vec3(v[0] / angle, 0, v[1] / angle), angle) : new Quaternion();
  return swing.mult(new Quaternion().setFromAxisAngle(new Vec3(0, 1, 0), v[2]));
}

export function sampleMove(move, tSec, basisQuat, outTargets, { mirror = 1, from, alpha = 1 } = {}) {
  const frames = move.keyframes;
  const t = Math.max(0, Math.min(move.duration, tSec));
  let i = 0;
  while (i < frames.length - 2 && t > frames[i + 1].time) i++;
  const a = frames[i], b = frames[i + 1], u = (t - a.time) / (b.time - a.time);
  // Slerp relative joints, then compose world targets: independent world slerps
  // would introduce off-axis elbow/knee rotations between otherwise valid keys.
  for (const [name, parent] of Object.entries(PARENTS)) {
    const source = mirror < 0 ? name.replace(/[LR]$/, s => s === 'L' ? 'R' : 'L') : name;
    let qa = quat(a.targets[source]), qb = quat(b.targets[source]);
    if (parent) {
      const sourceParent = PARENTS[source];
      qa = quat(a.targets[sourceParent]).conjugate().mult(qa);
      qb = quat(b.targets[sourceParent]).conjugate().mult(qb);
    }
    const local = qa.slerp(qb, u);
    if (mirror < 0) { local.y *= -1; local.z *= -1; }
    if (from?.[name] && parent && from[parent]) {
      local.copy(blendJoint(from[parent].conjugate().mult(from[name]), local, Math.max(0, Math.min(1, alpha))));
    }
    const out = outTargets[name] ||= new Quaternion();
    (parent ? outTargets[parent] : basisQuat).mult(local, out);
    if (!parent && from?.[name]) from[name].slerp(out, Math.max(0, Math.min(1, alpha)), out);
    out.normalize();
  }
  return outTargets;
}

export function moveImpulses(move, t0, t1, mirror = 1) {
  const events = move.impulses.filter(i => i.time > t0 && i.time <= t1);
  return mirror < 0 ? events.map(e => ({ ...e,
    ...(e.angular && { angular: [e.angular[0], -e.angular[1], -e.angular[2]] }),
    ...(e.linear && { linear: [-e.linear[0], e.linear[1], e.linear[2]] }),
  })) : events;
}
