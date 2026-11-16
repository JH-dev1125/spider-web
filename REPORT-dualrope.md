# REPORT: two ropes at once (branch JH-dev1125/dual-rope)

## What it does
- Q/A/Z fire into slot **L** (left hand) and E/D/C into slot **R** (right hand). If you hold Q and E together, two webs fly and two ropes attach.
- Each slot has its own web flight, its own `DistanceConstraint`, its own reel and its own tension. Both constraints are in the cannon world at the same time, so the solver combines the two pulls. Nothing is averaged.
- A key on a slot that is already held replaces only that slot. Releasing a key releases only its slot. Releasing both, blur, or death releases everything. A release only removes a constraint, so the velocity is never touched.
- W / side `'C'` (not on this branch yet) is handled in `game.js slotFor`: it uses a free hand first. If both hands are busy, it replaces the slot that was pressed longer ago. `{type:'release', side:'C'}` finds that slot again through `g.cSlot`.
- Zip with two ropes: the snap and the pull go along the normalised sum of the unit vectors to the anchors. It arrives when it gets near the nearest anchor, draws level with every anchor along z, or stops closing. Then every rope lets go. With one rope this is exactly the old zip (all old zip tests pass unchanged).
- Wall run and roof run are unchanged. Roof run now means "no rope at all".

## New module: `src/ropes.js` (body-agnostic)
`createRopes(world)` returns `{ slots, attach(slot, anchorPoint, body, localPivot?), release(slot?), stepReel(h), tension(slot), active(), latest(), view() }`.
- `attach` returns `null` and keeps the held rope if the anchor is closer than `minRopeLen`.
- `localPivot` is real: `DistanceConstraint.update` is overridden so the equation measures from body + rotated pivot to the anchor. A test swings a spinning box and checks it. The ragdoll can pass a hand body and a palm offset.
- `tension(slot)` returns `-distanceEquation.multiplier` (N, from the last solve; cannon stores lambda/dt there).
- `view()` returns `[{slot, anchor, len, tension}]`. `anchor` keeps its identity for the rope's lifetime (the bot's zip check uses that identity).

## Hook lines
**player.js**
- `import { createRopes } from './ropes.js';`
- `const ph = { world, hero, ropes: createRopes(world), ... }` (the old `ph.anchor` / `ph.rope` / `ph.reelRate` are gone)
- `export function attach(ph, p, point, slot = 'R')` → `ph.ropes.attach(slot, point, ph.hero)`. This is the line to change to the ragdoll hand body plus pivot.
- `export function release(ph, p, slot)`: slot omitted means all.
- `ph.ropes.stepReel(h);` before `world.step(h)`
- `syncRopes(ph, p)` at the end of `stepPhysics` and after attach/release. It fills `p.ropes`, and fills `p.anchor` / `ropeLen` / `ropeMin` from the most recent rope.
- `zipDir(ph)` (sum of unit vectors) is used by `setZip`, the zip force and `zipCheck`. The change is local to those three spots, so it should merge easily with the slingshot-zip rework.

**game.js**
- `g.webs = {L, R}`, `g.cSlot`, `g.shots`, `g.slotSeq`. `g.web` is still the most recent flight, for the renderer and existing tests.
- `fire()` → `slotFor(g, side)`; `flyWebs(g, dt)` → `attach(g.phys, g.player, w.to, slot)`
- release: `const slot = a.side == null ? null : a.side === 'C' ? g.cSlot : a.side; ... release(g.phys, p, slot)`
- `createBot({ zip, dual })`: `?dualrope` in main.js presses the best aim on each side.

**render.js** (minimal)
- `const rope2 = strand(1), splat2 = splat.clone()` draws the second held rope. `second = p.ropes.find(r => r.anchor !== p.anchor)`.
- `hero.update(..., anchor2, vHand2)` returns the second hand position for rope2. The first rope, the flash and the web flight are unchanged.

**character.js** (small)
- `update(..., wall = 0, other = null, outOther = null)`: the free arm (`mirror ? shR : shL`) gets the same IK-lite toward `other`, blended by `ikW2`, and `outOther` gets that hand's position.

## Input contract change
- `createChargeTracker` keeps one aim per side (`Map side -> aim`). `press(side, level, t)` replaces only that side. `release(side, level, t)`: the level must match unless it is `null`, so the keyup of a superseded key on the same side is stale. `release(null, null, t)` releases all. `state(t, side?)` gives that side's aim, or the most recent aim if no side is given. `move()` was removed (no caller).
- Actions: `{type:'press', side, level}`, `{type:'release', side, level, heldSec}` (one side), `{type:'release'}` with no side (all: blur, lost tracking, death). The keyboard code only needed a comment change.
- Hand (`createHandController`): the old single `active` hand is replaced by `owner = {L, R}`. A hand drives the slot of the screen half it was in when it entered the pose, and releases only its own slot (`tracker.release(side, null, t)`). A second hand pressing an owned slot replaces it, and the superseded hand's release does nothing. Re-press after `tracker.cancel()` happens per slot. Zip works from any owning hand.

## Tests (149 pass: `node --test tests/*.test.js`)
New: two ropes plus two constraints and both tensions > 0; the two-rope trajectory differs from L-only and R-only (and stays nearer the middle); release Q keeps R; release both / blur clears both; momentum is bit-exact on each release, and only gravity and drag act after the last one; Q again replaces only L; death releases both; zip kicks along the unit-vector sum and releases both; dual bot over 6 seeds × 30 s has no teleport, no penetration, and >300 frames on two ropes; hand: two hands mean two ropes and one hand opening releases only its own; hand: a superseded hand on the same half; `ropes.js` pivot, short-rope and slot-independence tests; W/'C' slot choice.
Changed to the new rule (on purpose): "a new press replaces the rope" now uses the same side; the tracker's stale-release / move tests; the hand "most recent owns the aim" test and the lost-hand release payload (now carries `side`).
Bot survival bar: the single bot survives 40/40 of seeds 1–40 (≥ 36 required).

## Screenshots
`C:\Users\jhgim\OneDrive\Desktop\MyGame\.superpowers\shots\dual-{3,5,8,12}.png` (`?autoplay&dualrope&t=N`). Both ropes show with their own splats. In dual-5 each rope leaves its own hand.

## Concerns
1. **The dual demo bot survives only 9/40** (the single bot survives 40/40). Its release rule (let go on the climb of the most recent rope) is not tuned for two ropes. Ropes to opposite walls cancel the sideways swing, so the fling is weaker. It is a screenshot/demo aid and not part of the survival bar. Tuning it is out of scope.
2. **Swing phase is shared**: `p.swingPhase` / `'bottom'` reset on every attach, so they follow the most recent rope. That is fine for the shake and the bot, but they are not per-slot.
3. **Arms**: in the overhead swing pose both hands sit close together, so in some frames (dual-3, dual-12) the two ropes leave from nearly the same point. Arm choice follows `mirror` (the most recent anchor's side), not the slot. If both ropes go to the same wall, the free arm crosses over. The ragdoll work will replace this anyway.
4. **Zip arrival with two ropes** releases both ropes together, not per slot. That is the simplest choice that matches "launch on the combined direction". The slingshot rework may want a different rule.
5. `aim(g, 'C', level)` depends on `aimVector('C')` from the W branch. On this branch only the slot logic is tested.
6. The `localPivot` override replaces `DistanceConstraint.update` per instance. If cannon-es is upgraded, recheck the `ri` / `rj` / `ni` convention.

Co-authored note: no push or merge; the coordinator merges.
