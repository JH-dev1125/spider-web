# REPORT — richer buildings + W key (branch `JH-dev1125/buildings-renewal`)

## What changed

- **`src/archetypes.js`** (new, pure). `buildBuilding(footprint {id, x0, x1, z0, z1, streetSide}, height, rng, difficulty) -> boxes[]`.
  It works in a local frame (a = in from the street face, u = along it, y), so `streetSide` can be `'+x' | '-x' | '+z' | '-z'`
  (or ±1). That means it also works for streets that run along x after a corner turn. `streetLot(id, sd, W, depth, z0, z1)` builds the footprint of a lot on today's corridor.
  Ids are `<lot prefix>:<part>` (`R12:base`, `R12:t0c3`, `R12:needle`). Every box carries `arch` and `facing`, plus `shape` and `light` where they apply.
- **Hollow frames retired.** `weightsEnd.frame` and `offWeights.frame` are now 0. The weight went to towers and cranes.
- **Terrace bands** (open floors in the middle of a tower). Each band is a floor `slab`, a 6 m open storey with two rows of
  1.6 m `column`s (attach false, spaced 9 m), and a ceiling `slab`. Nothing else is in the band, so a web flies between the columns and out the back.
  How many bands a tower gets depends on difficulty: none at p = 0 (the easy first 400 m), up to 3 on `terrace` towers at p = 1.
  Reachability rule (`BAND`): a band starts at ≥ 9 m, is open for ≤ 6 m, and has ≥ 15 m of solid face above it and between bands.
  So if a web at any flight height would land in the band, the `hi` web (+13 m at `aimAhead`) lands on solid face. The face block's top piece stays kind `tower` with `max.y` equal to the lot height, so `isSureAnchor` and the "no impossible section" invariant still hold.
  Nothing attachable (signs, balconies) is hung in front of a band.
- **W key / side `'C'`.** `CFG.keys.KeyW = ['C', 'mid']` and `CFG.aimUpDeg = { hi: 30, mid: 20, lo: 16 }`. The web goes straight ahead along the
  street and up. The bot also tries `'C'`. Hand control: a palm in the middle third of the preview = `'C'` (`CFG.handSideCuts`). The status line shows `정면 위`, and the preview has two vertical guide lines.
  Cranes were made reachable by W: jib height 42–70 m (was 60–100), and the jib now overhangs 20–27 m (was 6–18), so it crosses the centreline.
  The crane weight late in the course is 0.2 (was 0.1), plus 0.2 on the empty side of one-sided stretches.
- **`src/render-buildings.js`** (new). It draws the new kinds with its own instanced batches. It also handles: archetype facade colour and style
  (brick / stone / glass) for the tower blocks that render.js draws; lit windows (warm and cool rooms, an interior back wall offset by the view angle, about 2% flickering);
  additive halo quads that fade in fog (neon, billboard uplights, the clock dial, terrace lamps, street-lamp heads); light pools on the street; and red aircraft lights on spire, mast and pyramid tips that blink slowly. No postprocessing.
- `spike/buildings.html?shot=skyline|terrace|neon|crane` — staged scenes for screenshots. `?seed=<n>` in the game fixes the course.

## Archetypes (11, picked by hash among those that fit the lot height)

| tall (≥ 36 m) | low |
|---|---|
| `deco` setbacks + stainless crown + needle (aircraft light) | `brownstone` brick + fire escape + sometimes a neon bar sign |
| `empire` stepped tiers + slim crown + antenna mast | `walkup` + water tank on legs + short fire escape |
| `clock` brick + clock stage at the face, lit dial, pyramid roof | `warehouse` low brick + rooftop billboard |
| `glass` curtain wall + penthouse + mast, sometimes a big wall ad | |
| `gothic` corner pinnacles + tier + central spire | |
| `pyramid` tier + verdigris/slate pyramid roof + beacon | |
| `billboard` rooftop billboard on posts + vertical neon (HOTEL/BAR/DINER/JAZZ) | |
| `terrace` mixed use: 1–3 terrace bands + projecting balconies | |

Any tall archetype can also get a terrace band when p > 0. All signs and ads are made-up brands drawn on a canvas atlas.

## Hook lines in shared files

- `world.js`: `import { buildBuilding, streetLot } from './archetypes.js';`
  - in `tower()`: `out.push(...buildBuilding(streetLot(id, sd, W, depth, z0, z1), h, rng, d));` (replaces the base, setback and ledge pushes)
  - `low` lots: `else if (kind === 'low') w.structures.push(...buildBuilding(streetLot(id, sd, W, range(rng, L.depth), z0, z1), range(rng, L.lowH), rng, d));`
- `web.js` (`aimVector`, first line): `if (side === 'C') { const up = CFG.aimUpDeg[level] * RAD; return { x: 0, y: Math.sin(up), z: Math.cos(up) }; }`
- `render.js`: the import; `const decor = createBuildingDecor(THREE, scene, facade);`; `if (decor.owns(kind)) return parts;` in `describe`;
  `}, decor.facade(s));` in `solid()`; `const body = solid();` + `Math.floor(body.style)` (sills follow the archetype style);
  `const exposed = !listHasUpper(s) && !s.arch;` (no random tanks or antennas on archetype roofs); `decor.sync(list);` in `syncStructures`;
  `decor.tick(view.t, cam.z);` before `gl.render`.
- `main.js`: the zone guides loop over `CFG.handSideCuts`; one title line for W; the hand-hint line mentions the middle zone; `?seed=`.
- `render-math.js`: the camera spring arm ignores thin kinds (`THIN` set: column, spire, sign, balcony, clock, tank, plus ledge/frame).
- `hand-classify.js`: side from the thirds; the status text for `'C'`. `game.js`: the bot tries `'C'`; the contract comment lists the new kinds.
- `config.js`: `aimUpDeg`, `KeyW`, `handSideCuts`, the crane height/reach, and the weights.

## Numbers

- Draw calls (`?stats`, `renderer.info.render.calls`): **48–51** in game runs, 43–49 in the staged scenes (budget about 80). The renderer adds 12 batches.
- Triangles: **100k–155k** per frame.
- Physics boxes alive (seed 3): 68 at z = 200, 82 at z = 1500, 191 at z = 5000 (before: about 20). The existing test keeps the count < 400.
  Bot runs over 12 seeds × 180 s: average 588 m (base commit 65a384c: 512 m). No regression.
- FPS was not measured on real hardware. SwiftShader headless isn't representative.

## Tests

`node --test tests/*.test.js`: **145 pass, 0 fail**. New tests:
- `tests/archetypes.test.js`: boxes are solid, non-empty and don't overlap inside the footprint (fixtures may stand ≤ 1.5 m proud); every archetype appears at least 5 times in 600 lots;
  band rules (only non-attachable columns inside the band, solid face above it); a cannon ray through the band misses while the slabs hold; `±z` street sides.
- web: W is straight ahead and steep. game: W lands on a crane jib over the street and swings the hero; side webs miss there.
- hand: the middle third is `'C'`. world: jibs cross the centreline, are within W reach from 30 m, and appear about every 300 m late in the course. Kinds, attach and variety tests were updated (no frames).

## Screenshots (`C:\Users\jhgim\OneDrive\Desktop\MyGame\.superpowers\shots\bld-*.png`)

- it1: game runs (neon HOTEL, clock dial, street light pools), terrace close-up, brownstone fire escapes + rooftop billboard, crane.
- it2: skyline (deco needles, Empire masts, setbacks), neon DINER, wall ad. W pitch lowered from 30° to 24°.
- it3: W rope on the jib (20°), late game run.

## Concerns

1. **W anchors sit near the top edge of the frame.** The follow camera looks about 10° down and the vertical half-FOV is 30°. A 20° web lands just inside the frame,
   and the anchor leaves the frame as the hero swings under it. A camera tilt toward 'C' anchors would help, but `followCamera` isn't mine, so I didn't change it.
2. **Merges.** `world.js` `tower()` will conflict with the grid rewrite. Keep the one line `out.push(...buildBuilding(streetLot(...)))`. For streets along x, call
   `buildBuilding({id, x0, x1, z0, z1, streetSide: '+z'|'-z'}, h, rng, d)` directly. The dead `frame()` function and the `setbackChance` / `ledgeChance` / `setbackInset` / `setbackH`
   config keys are left in place to keep the diff small; they're unused now. In render.js, the `decor.facade(s)` / `body.style` / `exposed` lines are in Codex's facade code.
3. **Window lights patch** works by string-matching render.js's `col = mix(tint * light, glass, t.r);`. If Codex rewrites that line, the patch is skipped with a console warning and windows go back to plain.
4. Render.js's sills assume ±x faces. They're not right for a ±z-facing building (the archetype boxes themselves are fine).
5. Spire needles and masts are 1.2–1.6 m physics boxes. At top speed that's about 3 physics steps, the same thickness rule the old frame beams used.
6. There are more physics bodies late in the course (about 190). The bot tests run at the same speed, but I didn't profile cannon on a low-end laptop.
