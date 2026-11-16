# Portable motion layer handoff

Implemented on `JH-dev1125/ragdoll-moves`. No main-checkout files were edited.
No push, merge, renderer integration or screenshots.

## Deliverables

- `src/moves.js`: `MOVES`, `pickTrick`, `sampleMove`, `moveImpulses`.
  Ten weighted, airtime-gated tricks: corkscrew, frontHalfTwist, layoutBackflip,
  swanDive, superheroDive, splitKick, tuckBurst, thwip, spreadEagle, slingshotWhip.
  No `roll` in the new table. Every trick has `cancelOnPress: true`.
  Nine support moves: glide, preland, landing, roofIdle, roofTumble, swingReach,
  swingStrain, release, zipYank.
- All public keyframes are complete basis-relative **YZX Euler radians**, named
  per main's ANATOMY. Sampling slerps parent-relative quaternions and composes
  world targets, preserving hinge axes and reusing output quaternions. Times
  clamp; impulses use (t0,t1]. Linear events are whole-body delta-v in m/s;
  angular events are whole-body angular impulses in N m s, launch-basis frame.
- `src/zip.js`: pure `{dv,dir}` launch math. Additive 20 m/s default, normalized
  heading/rope, upward lift, <=30-degree horizontal deflection including bias
  .6, stationary fallback, finite-input/tuning validation. No side effects.
- `src/config.js`: added only the moves section and four new zip keys. Legacy
  motion/zip entries remain because this worktree's old callers still use them.
- `docs/motion-hooks.md`: driver target/event/blend hooks, state and units,
  cancellation/selection, root spin handling, prelanding/death settling, start
  tower/idle/tumble, physical Y-rope and tension/arm reach requirements, one-shot
  zip/cooldown/input migration, effects/text and coordinator acceptance checks.
- `tests/fixtures/ragdoll.js`: snapshot of the requested main-checkout file,
  read-only source; only its vendor import was rebased for its fixture location.
  Nothing copied into `src/ragdoll.js`.

## Executed proof

`node --test tests/*.test.js`: **146 passed, 0 failed** (including ten new tests).

New tests cover all keyframes and 103 samples per move (outside endpoints too),
finite unit quaternions, ANATOMY cone/twist/hinge limits, basis composition,
input purity/output reuse, 3,000 seeded releases covering all ten tricks without
immediate repeat, airtime filtering and impulse interval partitioning.

The final landing target places its knee and fist within .12 m of the target
rig's support plane using oriented ANATOMY box extents, with torso ~25 degrees
from upright and a subsequent head lift. Strain reduces both elbow bends.
Zip direction is checked over all sampled travel/rope azimuths at biases .4,
.5 and .6, including fallback and invalid-input cases.

One-second, 120 Hz zero-gravity simulations chase each of the 19 moves using
the copied rig/constraints and an inertia-scaled PD harness. No NaNs or velocity
explosion; joint pivot separation <.12 m; internal muscles preserve total linear
momentum to 1e-5. These isolated simulations intentionally omit external move
impulses and do not execute the unfinished main driver.

## Integration risks and remaining acceptance

The main checkout is still being rewritten. Its existing driver reaches about
**357 rad/s at handL on step 2** in a standalone glide run, before any new moves.
Reproduce by constructing `makeRagdoll` in zero gravity, setting p.alive=true,
p.mode='glide', calling `driveRagdoll` then `world.step(1/120)` twice. It uses
fixed gains on tiny-inertia hands. The smoke harness instead uses inertia-scaled
gains (`kp=144*I`, `kd=24*I`); the coordinator must stabilize/calibrate the real
driver. Do not read the passing harness as verification of the main controller.

ANATOMY masses total **70 kg**, different from legacy CFG.heroMass=80. Zip must
apply actual mass-weighted impulses. Root upright PD must not fight physical
spin impulses, and muscles must remain enabled after death for the landing hold.

Press cancellation, grounded contact/hold, 3 s rooftop balance, tower generation,
launch pitch/departure, two-hand proximity/load sharing, zip release/cooldown and
delivered velocity, effects/text/input migration, collision clearance and bot
survival with the **new ragdoll integration** remain coordinator checks. Existing
bot/zip tests passed for this branch's old game, not the unfinished integration.
The pure modules cannot guarantee physical contacts, a complete rotation,
reachability or screenshots. These boundaries and the exact migration sites are
documented in `docs/motion-hooks.md`.

The pre-existing untracked `package-lock.json` was left untouched and excluded.
