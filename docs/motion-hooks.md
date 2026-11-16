# Motion layer integration

This branch supplies **pure targets and launch math**, not an integrated controller.
These hooks are based on the uncommitted main-checkout `ragdoll.js`, `player.js`
and `game.js` read on 2026-11-16. Apply them to that ragdoll rewrite, not this
branch's older sphere player. Do not replace the main ragdoll with the fixture.

## Contract and units

```js
import { MOVES, pickTrick, sampleMove, moveImpulses } from './moves.js';
import { zipLaunch } from './zip.js';
```

`MOVES[name]` has `name`, `trick`, `duration` (seconds), `minAirtime`, `weight`,
`cancelOnPress`, `keyframes: [{time, targets}]`, and `impulses`. Only the ten
`trick: true` moves participate in selection. `pickTrick(rng,last,airtimeLeft)`
returns a move or `null`; `last` accepts a move or name. Weights come from
`CFG.moves.weights` at module initialization. Do not keep the old `roll` picker.

Every keyframe contains every ANATOMY body, **orientation relative to the
whole-body basis**, in **YZX Euler radians**. Cannon's `toEuler` supports YZX;
reconstruct with `q.setFromEuler(x,y,z,'YZX')`, not the default XYZ. The table is
authored through parent-local rotations and converted into this public format.
`sampleMove(move,seconds,basis,out)` clamps time, updates/reuses Cannon quaternions
in `out`, and returns `out`. It slerps parent-local quaternions before composing
world targets; this preserves hinge axes between keys. It never writes bodies.
Callers may blend world targets into their current targets after sampling.

`moveImpulses(move,t0,t1)` returns only events in **(t0,t1]**. Initialize the
clock to `-Number.EPSILON` so time-zero launch events fire exactly once. Never
wrap that clock or replay impulses when a move is held at its last frame.
Only the `roofIdle` *sampling* time loops (`age % duration`).

Event `linear` is **whole-body delta-v, m/s**; event `angular` is **whole-body
angular impulse, N m s**. Both are vectors in the basis captured at move start.
Rotate them to world space once. Spins come from these impulses and physics,
never a time-dependent rotation assigned to the skeleton or root body.

## Shared controller state (player.js)

Add to `ph` in `createPhysics`:

```js
motion: null, lastTrick: null, pendingTrick: null, targetBlend: null,
zipKick: null, zipCooldown: 0, landing: null, startPhase: 'idle',
```

Add these exported helpers (use the module's existing CANNON import):

```js
export function startMove(ph, move, basis) {
  ph.motion = move ? { move, sec: -Number.EPSILON, basis: basis.clone() } : null;
  ph.targetBlend = {
    sec: 0,
    from: Object.fromEntries(Object.entries(ph.rag.targets).map(([n,q]) => [n,q.clone()])),
  };
}

export function travelBasis(p) {
  const speed = Math.hypot(p.vel.x, p.vel.z);
  return new CANNON.Quaternion().setFromEuler(0,
    speed > .1 ? Math.atan2(p.vel.x,p.vel.z) : (p.headingYaw || 0), 0);
}
```

Keep the existing mass-weighted `impulse(ph,dv)` for linear events. For angular
events, apply a coherent rigid angular impulse about the current centre of mass.
Adding torque only to the pelvis produces a large transient joint load; adding
the same angular velocity to each body without orbital velocities is not a
whole-body rotation. This helper applies both components and adds no net linear
momentum:

```js
function angularImpulse(ph, J) {
  const bodies = Object.values(ph.rag.bodies);
  const mass = bodies.reduce((m,b) => m+b.mass, 0);
  const com = bodies.reduce((v,b) => v.vadd(b.position.scale(b.mass/mass)), new CANNON.Vec3());
  const axes = [new CANNON.Vec3(1,0,0), new CANNON.Vec3(0,1,0), new CANNON.Vec3(0,0,1)];
  const I = new CANNON.Mat3();
  for (let col=0; col<3; col++) {
    const axis = axes[col], total = new CANNON.Vec3();
    for (const b of bodies) {
      const r = b.position.vsub(com);
      const local = b.quaternion.conjugate().vmult(axis);
      local.set(local.x*b.inertia.x, local.y*b.inertia.y, local.z*b.inertia.z);
      total.vadd(b.quaternion.vmult(local), total);
      total.vadd(r.cross(axis.cross(r)).scale(b.mass), total);
    }
    I.e(0,col,total.x); I.e(1,col,total.y); I.e(2,col,total.z);
  }
  const omega = I.solve(J);
  for (const b of bodies) {
    b.applyImpulse(omega.cross(b.position.vsub(com)).scale(b.mass));
    b.angularVelocity.vadd(omega, b.angularVelocity);
  }
}
```

## driveRagdoll: target hook, basis and gain changes

1. Delete `if (!p.alive) return`: landing muscles must continue after street
   contact. Remove the `p.mode === 'roll'` basis rotation. Remove flailing `fall`
   targets/renderer flail once the new path is wired.
2. Keep the existing gait and web reach target generation as the default. Just
   **before** the pelvis `muscle(...)` call, insert this block:

```js
const motion = ph.motion;
if (motion) {
  const prev = motion.sec;
  motion.sec = Math.max(0, prev) + h;
  for (const event of moveImpulses(motion.move, prev, motion.sec)) {
    if (event.linear) impulse(ph, motion.basis.vmult(new CANNON.Vec3(...event.linear)));
    if (event.angular) angularImpulse(ph, motion.basis.vmult(new CANNON.Vec3(...event.angular)));
  }
  const spinning = motion.move.impulses.some(e => e.angular);
  const frame = spinning ? b.pelvis.quaternion : motion.basis;
  const sec = motion.move === MOVES.roofIdle
    ? motion.sec % motion.move.duration : motion.sec;
  sampleMove(motion.move, sec, frame, t);
}
if (ph.targetBlend) {
  const blend = ph.targetBlend;
  blend.sec += h;
  const u = Math.min(1, blend.sec / CFG.moves.blendSec);
  for (const name of Object.keys(t)) blend.from[name].slerp(t[name], u, t[name]);
  if (u === 1) ph.targetBlend = null;
}
```

`impulse`/`angularImpulse` live in player.js, so **pass them as callbacks** to the
driver rather than introducing an import cycle. Change its signature and call:

```js
// ragdoll.js
export function driveRagdoll(ph, p, h, impulse, angularImpulse) { /* existing body + hook */ }
// player.js, inside the fixed-step loop
driveRagdoll(ph, p, h, impulse, angularImpulse);
```

3. Drive the root toward **`t.pelvis`**, replacing the old `basis` argument to
   `muscle(b.pelvis,...)`. During an impulse spin, disable its upright spring
   **and damping**; otherwise it fights the flip. On expiry, capture targets via
   `startMove(ph,null,travelBasis(p))` and let the existing glide/swing targets
   take over with the blend above. Hold `landing` indefinitely. On completion of
   `release`, start `ph.pendingTrick`, then clear it; leave `roofIdle` running
   until start, and end `roofTumble` into glide (not a new random trick).

```js
const spinning = ph.motion?.move.impulses.some(e => e.angular);
const landing = !!ph.landing;
if (!spinning) muscle(b.pelvis, t.pelvis, null,
  landing ? 1600 : (ph.wall || p.roof ? 1600 : 180),
  landing ? 110 : (ph.wall || p.roof ? 110 : 25),
  landing ? 650 : (ph.wall || p.roof ? 650 : 100));
```

The WIP `muscle` gains are not stable for the hands: a direct `driveRagdoll`
glide run reaches ~357 rad/s on `handL` at step 2, without these moves. Before
integrating, scale gains/damping to rotational inertia or use an implicit PD
update. Our isolated smoke test uses `I=min(body.inertia,parent.inertia)` across
axes, `kp=144*I`, `kd=24*I`, torque cap 200. It verifies target stability, not
the WIP driver. Calibrate a stiff landing phase on top of stable gains, for
`CFG.moves.landingStiffSec`, then reduce to hold gains. Preserve equal/opposite
parent torques. Internal muscle torques must never apply linear forces.

## B: release selection and immediate press cancellation (game.js)

Import `MOVES,pickTrick` and `startMove,travelBasis`. Delete `pickTrickPose`, the
`CFG.character.tricks` choice, and old `trickSec`/`fall` selection. In the press
branch **before** `fire(g,a)`, even if the shot will miss:

```js
if (g.phys.motion?.move.cancelOnPress || g.phys.motion?.move === MOVES.release) {
  g.phys.pendingTrick = null;
  startMove(g.phys, null, travelBasis(p));
}
fire(g,a);
```

In the ordinary release branch, only when `release(ph,p)` succeeds:

```js
const footY = Math.min(...['footL','footR'].map(n => ph.rag.bodies[n].position.y - .05));
// Conservative street airtime; drag slows the descent, making this a lower bound.
const vy = Math.min(0,p.vel.y);
const airtime = (vy + Math.sqrt(vy*vy + 2*CFG.gravity*Math.max(0,footY))) / CFG.gravity;
const next = pickTrick(g.rng, ph.lastTrick, Math.max(0,airtime-MOVES.release.duration));
ph.pendingTrick = next;
if (next) ph.lastTrick = next.name;
startMove(ph, MOVES.release, travelBasis(p));
events.push('released');
```

Use `const ph=g.phys` at function entry. `release` visually lets the lower L
hand open first; it leaves the top R arm raised at .06 s. For a left shooting
hand, mirror this move (swap L/R and sagittally reflect the basis-local
quaternions: `[x,y,z,w] -> [x,-y,-z,w]`) before composing world targets. Keep
lastTrick across attachments. A zip uses `zipYank` and bypasses this release
selection, so the generic `released` event handler must not override it.

## C: prelanding, street contact, hold, result timing

In player.js before `driveRagdoll`, while descending with no rope/wall/roof,
compute street airtime as above. When it is below `CFG.moves.landingLeadSec`,
cancel pending tricks and start `MOVES.preland` with an upright travel basis.
Keep this phase active until contact; do not restart its clock every step.
This engages the root uprighting spring and extends the legs during the fall.
On the first **actual upward street contact** (identify the ground body in
`world.contacts`, not just a centre-y threshold), replace the old death block's
motion changes with:

```js
release(ph,p); clearGait(ph); ph.wall=null; p.wall=0; p.roof=false;
p.alive=false; ph.pendingTrick=null;
ph.landing={ sec:0 };
startMove(ph,MOVES.landing,travelBasis(p));
events.push('dead','landingImpact');
```

Increment `ph.landing.sec` by `h` on subsequent physics steps, not at input/frame
rate. Keep calling physics and muscles on the over screen. The landed target
puts the L knee and L fist low and the R leg forward, torso tilted ~25 degrees,
then lifts the head at the last key. **Orientations do not guarantee contact**:
use the existing leg reach solver/contact machinery to settle the pelvis height,
reach L fist/L knee to street y=0 and place the R sole. Apply bounded contact
forces/PD, never teleport bodies. Ground friction/settling must dissipate the
incoming travel velocity. Do not pin an airborne fist or lower the body through
the street. The table's knee/fist geometry test uses actual ANATOMY pivots but
does not claim a ground-contact integration test.

On `landingImpact`, spawn one dust puff and set a short camera dip/kick. In
main.js replace the `overSec >= CFG.overFallSec` result gate with
`g.phys.landing?.sec >= CFG.moves.landingSettleSec`; start result timing on
impact, not prelanding. Hold the final pose after the 1 s result delay. Renderer
work, contact support and death-camera behavior are coordinator integration.

## D: guaranteed tower and physical back tumble

`world.js` must generate a **persistent guaranteed start tower**, using its
normal `{id,kind,min,max,attach}` structure data, not a render-only prop. Its roof
is taller than every nearby generated roof; clamp/regenerate nearby lots below
it. Its front edge faces +z down the street. Spawn with heel boxes supported
just inside that edge, pelvis at roof y plus actual sole-to-pelvis height
(~1.02 m in the neutral rig), zero velocities and yaw PI (+z of the body faces
back toward the roof). Do not reuse the old mid-air `startSpeed` spawn.

After syncing the start structures in `createGame`, set:

```js
p.headingYaw=Math.PI; ph.startPhase='idle';
startMove(ph,MOVES.roofIdle,new CANNON.Quaternion().setFromEuler(0,Math.PI,0));
```

In idle, skip roof gait propulsion/reeling/airtime selection; retain standing
balance, foot contacts and subtle `roofIdle` muscles. Advance that physics on
the title screen too. At Space/open-palm start, **retain the same game/player**;
replace `start()` recreating the world with transitioning this state (recreate
only on restart). The start input must not also fire zip. Transition once:

```js
ph.startPhase='tumble'; p.roof=false; clearGait(ph);
startMove(ph,MOVES.roofTumble,new CANNON.Quaternion().setFromEuler(0,Math.PI,0));
```

Its time-zero local `[0,3.5,-5]` delta-v becomes world +z out over the street;
its +x angular impulse is a backflip in the roof-facing frame. Skip roof gait
and root upright assistance throughout tumble; don't let the roof raycast
re-enter run mode. Allow user web presses to interrupt tumble if desired, and
have the bot wait until the tumble completes. Capture `headingYaw=0` on exit.
Tune impulse/clearance against the integrated rig for departure <=.5 s and
unwrapped pitch >270 degrees; the pure target sampler does not prove either.

Extend world.js's reachability invariant to the **actual launch/fall positions**:
at least one first aim must hit a holdable face before min street clearance.
Generate a dedicated neighboring anchor building if normal lots fail. Position
the idle camera behind/above the roof-facing hero, then blend into follow-camera
during tumble. Require a 3 s no-input contact test before accepting this flow.

## E: two physical hands and tension-driven strain

Use a short Y: keep the existing upper-hand `ph.rope` and add `ph.ropeOther`, a
pull-only DistanceConstraint from the other hand to the same anchor. Its length
is `ph.rope.distance + .12` (the lower grip). Initialize the other rope from its
**current** distance, interpolate toward the lower grip over .25 s, then track
reeling on both. Preserve maxForce=0/SPOOK settings. Both paths carry tension;
`release` and replacement `attach` must remove **both** constraints, and removing
an old rope must not clear an in-progress zip kick. A single hand rope plus
cosmetic second-arm targets does not satisfy E.

After each solve, read actual tension for the next muscle step:

```js
const tension=Math.abs(ph.rope?.distanceEquation.multiplier || 0)
  + Math.abs(ph.ropeOther?.distanceEquation.multiplier || 0);
const load=Math.min(1,tension/CFG.moves.strainForce);
```

In the swing target path, sample `swingReach` for the .25 s attach/reach phase;
then sample `swingStrain` at `load * MOVES.swingStrain.duration`. Blend the load
with a short response rather than using arbitrary speed as tension. Keep the
existing directional arm reach, but target **both** hands to points .12 m apart
on the actual rope line (upper grip at the drawn line end). Use a two-link arm
reach solution analogous to `legTargets`, with elbow hinge [-2.5,.05], and
derive elbow extension from `load`. Clamp shoulder cone/twist to ANATOMY.
Let `swingStrain` supply chest crunch/head duck/knee tuck; root/balance follows
the actual rope direction and body sways through physics. Do not overwrite the
arm reach solution with a later static target sample. A Y to a distant anchor
does not constrain lateral hand spacing alone: muscle reach and both loaded
arm chains are required to hold each hand within .25 m of the line after .3 s.

For ordinary release remove the lower-hand constraint first and top-hand rope
in the same release update; the `release` target opens the lower arm first.
No delayed constraint removal for zip: both go immediately. Continue drawing
the single visible web from the original shooting hand, not pelvis/Y midpoint.

## F: instant zip action, release now, impulse over three steps

Delete `setZip`, `zipCheck`, the held force block in `stepPhysics`, and `ph.zip`.
After the callers migrate, delete old `zipImpulse`, `zipAccel`, `zipMaxSpeed`,
`zipReleaseDist` from config; they remain on this branch solely for its older
game/tests. In player.js add this replacement export:

```js
export function launchZip(ph,p) {
  if (!ph.rope || ph.zipCooldown>0 || !p.alive || ph.zipKick) return false;
  const v=ph.hero.velocity;
  const facing=travelBasis(p).vmult(new CANNON.Vec3(0,0,1));
  const heading=Math.hypot(v.x,v.z)>.1 ? new CANNON.Vec3(v.x,0,v.z) : facing;
  const ropeDir=ph.anchor.position.vsub(ph.hero.position);
  const {dv,dir}=zipLaunch(v,heading,ropeDir,CFG);
  const basis=travelBasis(p);
  release(ph,p); // removes both ropes and clears p.anchor NOW; preserve zipCooldown
  ph.pendingTrick=null;
  ph.zipCooldown=CFG.zipCooldownSec;
  ph.zipKick={dv,dir,remaining:CFG.zipLaunchSteps};
  startMove(ph,MOVES.zipYank,basis);
  return true;
}
```

Before each `world.step(h)`, after muscle forces:

```js
ph.zipCooldown=Math.max(0,ph.zipCooldown-h);
if (ph.zipKick) {
  const k=ph.zipKick, dv=new CANNON.Vec3(k.dv.x,k.dv.y,k.dv.z).scale(1/CFG.zipLaunchSteps);
  impulse(ph,dv);
  if (--k.remaining===0) ph.zipKick=null;
}
```

This uses the existing **mass-weighted whole-rig impulse**, including pelvis and
both hands, so every segment receives the same delta-v. Concentrating a 20 m/s
launch solely into the .6 kg hands can destabilize the WIP joints. If integrating
concentrated hand/pelvis load instead, preserve total mass*delta-v and verify the
extra joint loads. Do not use the default heroMass (ANATOMY's actual masses sum
to 70 kg), assign transforms, overwrite velocity, or keep a hidden rope.

In game.js replace the zip branches with:

```js
else if (a.type==='zip' && launchZip(ph,p)) {
  g.web=null; events.push('released','zipped');
  g.shake=Math.max(g.shake,CFG.render.shakePeak);
}
```

Do not let later generic release/trick handling overwrite `zipYank`; after its
.4 s duration, blend to trick/glide as airtime permits. `zipLaunch` is pure: it
does not own no-rope checks, release, cooldown, collisions, effects or input.
It adds `CFG.zipLaunch` along its returned unit `dir`; does not clamp current
velocity. Horizontal heading wins over lateral anchors; up-tilt uses normalized
rope direction and never points downward. Bias .6 is clamped laterally to the
30-degree heading cone. All vectors are finite `{x,y,z}`; zero heading falls
back to horizontal velocity, then +z. Invalid vectors/tuning throw RangeError.

In keyboard.js Space keydown keeps emitting one `zip` (ignore repeat); Space
keyup **returns without emitting anything**. Blur still cancels/releases web
input but sends no zipEnd. Remove zipEnd from game/main contracts/tests. The
hand-classify controller already sends a single `zip` per pull: keep that edge
action, align its cooldown with `CFG.zipCooldownSec`, and never synthesize a
held action/zipEnd. Update README and title copy to **"Space / hand pull: launch
forward and release web"**. Renderer triggers a brief camera kick and speed
lines on `zipped`, lasting beyond the three-step impulse.

## Proof and coordinator acceptance

`node --test tests/*.test.js` covers all authored keys/dense interpolations,
seeded selection, event boundaries, basis/output semantics, target landing
geometry, strain extension, heading cone, zip validation and one-second
zero-gravity fixture PD simulations. The fixture is a read-only snapshot of
main's ragdoll with only its vendor import rebased. The smoke controller uses
inertia-scaled gains and no external move impulses; linear momentum is checked
to 1e-5, joint pivot separation to .12 m. It is not the integrated driver.

Coordinator must run: immediate press cancellation (including missed shot),
release/zip ordering and cooldown, same-frame rope disappearance, ~20 m/s zip
gain over three steps, world collision/no penetration, real landing contact
(one knee and fist plus torso <=35 degrees), standing 3 s, launch <=.5 s and
pitch >270 degrees, hand-to-line <=.25 m after .3 s at several tensions, and bot
survival/reachable first web. Capture requested landing/start/flip/swing/zip
screenshots **after integration**; this branch deliberately captures none.
