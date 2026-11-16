# Forward swing: report

The swing now carries him forward instead of into the wall. Two things fixed it: the webs go high and forward, and his body steers the swing (body English). The bot also lets go earlier, on the rising side. Nothing forces his speed or heading.

## Swing metrics (bot, seeds 1–40, 30 s each, `tests/swing-metrics.js`)

| | before (HEAD 65a384c) | after | target |
|---|---|---|---|
| survive 30 s | 40/40 | 40/40 | ≥ 36/40 |
| median sideways excursion per swing (x range on the rope) | 11.8 m | **4.95 m** | < 8 m |
| median forward progress per swing (attach → next attach) | 23.1 m | **49.2 m** | ≥ 25 m |
| wall contacts / 10 s (touching any non-roof face, wall runs included) | 2.52 | **0.29** | < 1 |
| wall runs / 10 s (all of them accidental: the bot never wall-runs on purpose) | 2.46 | 0.26 | — |

- Seeds 41–140 after the change: 100/100 survive, sideways 4.95 m, forward 49.3 m, 0.34 contacts/10 s.
- 120 s runs, seeds 1–40: before, all 40 died (between 32 s and 84 s). After, 4 died (between 92 s and 109 s).

Rerun with `node tests/swing-metrics.js`. `tests/steer.test.js` asserts the four targets.

### What each piece contributes (seeds 1–40)

| configuration | sideways | forward | contacts/10 s |
|---|---|---|---|
| high webs + steer, old release 0.6 | 6.7 | 50.0 | 1.36 |
| high webs + release 0.3, no steer | 9.1 | 45.7 | 1.51 |
| high webs + steer + release 0.3 | 3.9 | 44.4 | 0.02 |
| **high webs + steer + release 0.4 (shipped)** | **4.95** | **49.2** | **0.29** |

All three are needed. With a high anchor he still ends up under it, and under it means at the wall, so he has to let go on the rising side, before he reaches the anchor's z. I took 0.4 over 0.3 because it gives longer swings and still clears every target.

## Aim values (`src/config.js`, used only inside `aimVector`)

- `aimAhead`: 52 → **40 m**. Each web meets its side's face 40 m ahead, from anywhere across the street.
- `aimPitchDeg`: `{hi: 14, mid: 0, lo: -30}` → **`{hi: 49.7, mid: 35.3, lo: 15.8}`**.

| level | rise | rope angle out of the forward-vertical plane |
|---|---|---|
| hi | +50 m | 12° |
| mid | +30 m | 15° |
| lo | +12 m | 19° |

These are from the centre, which is 42.4 m from the face. Every web now goes up.

To make sure the buildings are tall enough:
- `towerHStart` [60,120] → [100,160]
- `towerHEnd` [42,150] → [70,170]
- `goodH` 42 → 70, kept equal to the low end of `towerHEnd`, so every tower is still a sure anchor and the reachability invariant test passes unchanged.
- `startHeight` 50 → 55.

## Steering design: `src/steer.js`

`steerAccel(vel, heading) -> {x, 0, z}` is a pure function that returns m/s². Multiply by the body's mass to get a force, so the same function works on the sphere now and on the ragdoll's pelvis later. It has two parts, and neither adds speed:

- **turn**: `turn · |v_h| · (heading ⊥ v̂_h)`. It acts perpendicular to the horizontal velocity, so it rotates it toward the street heading and does no work. It is zero when he is moving backward along the street (a U-turn is not body English).
- **damp**: `−damp · v_lateral`. It only removes energy. It also outweighs the second-order speed gain that the turn picks up from the integrator, so speed never rises from one step to the next. `tests/steer.test.js` checks this over 600 steps in four cases.
- The total is capped at `steer.maxAccel` = 2.5 m/s². `turn` = 0.6/s, `damp` = 0.4/s.

It is applied as a force before `world.step`, so the rope constraint and momentum are handled by the solver as normal. It never sets a velocity.

### The hook in `src/player.js` (three added lines, no restructuring)

```js
import { steerAccel } from './steer.js';
const STREET = { x: 0, z: 1 }; // the street heading (the course runs along +z)
    if (ph.rope) { const a = steerAccel(v, STREET); hero.force.x += CFG.heroMass * a.x; hero.force.z += CFG.heroMass * a.z; } // body English (steer.js)
```

The last line sits in `stepPhysics`, just before the existing `if (ph.rope) { let len …` reel block. For the ragdoll, apply it to the pelvis with the pelvis mass. When the city grid lands, `STREET` becomes the current street's heading.

## Facing

No code change was needed. `character.js` (which I did not touch) already builds the rope pose with up along the rope and the chest along `vel`, orthogonalised. The steering now keeps `vel` along the street, so his chest points along his travel, not at the wall. The screenshots confirm it.

## Bot

`botReleaseClimb` 0.6 → 0.4. The bot lets go once vel.y/speed ≥ 0.4 on the rising side. Before, it held on until it was nearly under the anchor, which is at the wall.

## Tests changed

- `web.test.js`: the old "hi under 15 m" and "mid level / lo down" checks are replaced by the new geometry: the rise bands, 30–50 m ahead, and ≤ 20° for mid and hi.
- `game.test.js`:
  - "shot casts from the hand", skybridge and crane mast: positions are now computed from `aimVector` instead of hard-coded for the old pitches.
  - Zip auto-release: the "≤ ~11 m from the anchor" bound became "less than half the attach distance". A zip toward a 50 m-high anchor lets go by the existing pass-beneath rule while he is still well below it. The zip code itself is unchanged.
- `render.test.js` camera test:
  - The corridor blocks are now 200 m deep instead of 20. A zip toward a high web can fling him over the 200 m roof, and he used to drop into the strip behind it.
  - The "fast" check is per seed across the no-zip and zip runs.
  - The bot no longer drifts into walls, so one run now pushes him into a wall on purpose to film a wall run and its jump.
- New: `tests/steer.test.js` (steering, plus the four metric targets) and `tests/swing-metrics.js` (a reusable helper and CLI).

The full suite passes: 138/138.

## Screenshots (`.superpowers/shots/fwd-{4,7,11,15}.png`, gitignored)

Each shows him mid-swing in the middle of the street, the rope running steeply up and ahead, and his body facing down the street.

## Concerns

1. **The anchor is often off-screen.** A 50 m-high web leaves the top of a 60° lens. You see the rope go up, not the splat. The camera may need to tilt up while he's attached; that belongs in render.js, which I did not touch.
2. **Lower peak speed without zipping.** High anchors and the reel lift him rather than drop him into a dive. Over seeds 1–20 with the bot (zip runs in brackets):
   - median speed: 16.6 → 16.3 m/s (zip 37.2 → 29.6)
   - p95: 26 → 19 m/s (zip 64.3 → 59.8)
   - max: 37.4 → 21.1 m/s (zip 69.0 → 67.0)

   Zip speeds are unchanged. A human can still dive with `lo` or by letting go late. If the game should feel faster, lowering `lo` to about +5 m or reducing `reelMinFactor` would bring back dives.
3. **Altitude creep.** The bot climbs to about 85–130 m within 2 minutes, because the reel plus high anchors gain height. Taller towers (up to 170 m) keep it reachable, but late one-sided or low stretches could leave a high flyer with nothing to hit.
4. **Zip toward a hi anchor lets go about 25 m below it**, by the existing "passing beneath" rule, and can fling him over a roof. This is consistent with "keep the zip as is", but it looks different from before.
5. **Steering pulls toward a fixed street heading** (`STREET`). The city grid branch must pass the current street's direction, or corners will fight the steer. The 2.5 m/s² cap keeps that fight gentle.
6. The bot is the only "player" these metrics measure. Human timing will differ.
