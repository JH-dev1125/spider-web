# REPORT: city grid with corner turns + ropes that wrap round buildings

Branch `JH-dev1125/grid-corner-turns`. Not pushed or merged. `node --test tests/*.test.js`: 149 pass, 0 fail.

## What changed

| File | Change |
|---|---|
| `src/world.js` | Rewritten as a seeded Manhattan grid. z-streets sit at `x = lineAt(seed,'col',i)` (col 0 is x = 0) and x-streets at `z = lineAt(seed,'row',j)`. Lines are 120–200 m apart (`blockLen` 160 ± 2·`blockJitter`). Every block corner holds a tall solid **corner tower** (`K<col>_<row>_<q>`) that is always a sure anchor. Between two corners, `buildSegment` fills a street segment's two faces with the old lot generator: same kinds, same difficulty ramp (now by \|x\|+\|z\|), same coverage guarantee, and lots are clipped at the corners. Everything is a pure function of (seed, grid coords). `updateWorld(w, pos, street)` keeps only the current street (40 m behind to 260 m ahead) plus both cross-street segments at each intersection from 40 m behind to 2 ahead. `clampToStreets` puts blocks out of bounds. `w.fixed = true` freezes a hand-built test course; it replaces the old `nextZ = Infinity` trick. |
| `src/street.js` (new) | The street frame `{axis, lat, dir, line, centre}`, heading and right vectors, and local↔world conversion. |
| `src/rope.js` (new) | Rope wrapping. Each physics step, a raycast checks the hero→pivot segment. If a box cuts it, a bend is added on the box edge that the rope sweep (pivot, previous hero position, hero) meets first, `ropeWrapOffset` outside both faces. The constraint then pivots there with free length = total − wrapped. A bend is removed when the sign of `cross(bend−prev, hero−bend)·n` flips. The rope snaps (`'snapped'`) past `ropeMaxWraps` (4) or on a degenerate bend. |
| `src/player.js` | Small changes only: `ropePoints` on the player (reset on attach and release); `ph.street`; wall run, wall jump, roof run and zip release use the street's axes instead of hard-coded x/z; two per-step hooks after `world.step` (`ph.bound`, then `ropeStep`). |
| `src/game.js` | Holds `g.street` and `g.distance`. The street switches when the hero is in the cross street's corridor (≥ `turnInset` 3 m inside it) with horizontal velocity > 60% along the cross axis **and** more than along his own street, or when he has left his own corridor sideways. Aims are relative to the heading. When the 52 m aim point falls inside an intersection gap, it is pushed onto the far corner tower (`aimPastCross`); before this change, webs dove into the gap and hit corner faces facing back at the hero. Score = Σ Δpos·heading. A snap shows as the miss line. Bot changes: it skips anchors on faces that look back down the street, and it has `turn: 'L'\|'R'\|'alt'` (webs the near corner tower within `turnReach` of its edge, holds until the street switches). `nextCorner()` is exported. Contract comment updated (ropePoints, street, distance, ids, face, wall). |
| `src/render-math.js` | `followCamera(..., street)` works in its own yaw frame. Yaw eases toward the street heading at `camTurnFollow`, capped at `camTurnRate` 120°/s, and is returned as `cam.yaw`. FOV stays 60–68. With no street argument the old behaviour is unchanged (old tests pass as-is). |
| `src/render.js` | The rope is now a polyline (hand → bends → anchor, 5 strands), and the hero's arm points at the pivot. Street furniture and cars are placed on the current street. The skyline now sits inside block interiors instead of being mirrored across x = 0, which used to put it in the cross streets. Facade sills follow `s.face`, and detail LOD uses x and z distance. |
| `src/web.js` | `aimVector(side, level, x, ahead = CFG.aimAhead)`. |
| `src/main.js` | Shows `g.distance`. View gets `street`, `distance`, `seed`. Adds `?autoturn[=L\|R\|alt]` and `?seed=n`. |
| `README.md` | How the grid works, how to turn, wrapping and snapping, debug URLs. |

## Bots (30 s, DT 1/60)

| Bot | Seeds 1–40 | Seeds 41–100 |
|---|---|---|
| Straight (press/hold/release) | **38/40** alive (bar ≥ 36) | 49/60 (the old corridor build: 60/60) |
| `turn: 'R'` (free play) | 36/40 alive, 12 turns | — |
| Controlled turn test (hero placed 72 m before row 1, 45 m up, 20 m/s, both sides, seeds 1–8) | **16/16** turned onto the right street and still alive 8 s later | — |

## Tests added or changed

- `tests/world.test.js` (rewritten). Grid spacing; ids, contract and `face`; determinism, including the same boxes reached from two different routes; laziness, including that the next intersections' corners and cross segments exist and that a turn swaps the set; no box intrudes into a street; **no two solid buildings overlap**; skybridges are buried at both ends; no impossible stretch along z- and x-streets; variety; dense early course; `clampToStreets`.
- `tests/grid.test.js` (new). Corner turn: street switch, new street centre/dir, aims rotate, anchor on the near corner, he flies on. No diagonal escape over 30 s runs. Score equals the path integral, turns included. Camera yaw rate ≤ 120°/s, ends behind him, roughly frame-rate independent.
- `tests/rope.test.js` (new). Wrap point lands at the box edge. Length is conserved exactly through wraps and unwraps. The polyline never cuts a box at any frame. Swinging back unwraps. A 5th bend snaps the rope. Bot runs on the city never leave a rope through a box.
- `tests/game.test.js`, `tests/render.test.js`: only the fixed-course helper changed (`world.fixed`). Both now pass the street to the camera.

## Screenshots (`C:\Users\jhgim\OneDrive\Desktop\MyGame\.superpowers\shots\`)

- `grid-turn-approach.png`: `?autoplay&autoturn=R&seed=8&t=10.0`, swinging on the near-right corner tower.
- `grid-turn-after.png`: `t=10.3`, after the switch. The camera has turned down the cross street (traffic runs along it), and the corner tower with the anchor is on his left.
- `grid-wrap.png`: `?autoplay&seed=15&t=10.8`, a rope visibly bent round an edge (hand → bend → anchor).

## Known limits / for the coordinator

- **Merge with the ragdoll rewrite:** the player.js hunks are listed in the table above. `character.js` (not touched) still reads `player.wall` as a world-x normal and mirrors on `aim.x < pos.x`. On x-streets the wall-run lean and the arm mirroring can face the wrong way. Codex's rewrite should use the street frame (`view.street`, `street.js`).
- Blocks are an invisible bound (`streetMargin` 1 m). The hero can no longer land on or run across a low tower's roof inside a block. Roof runs still work on skybridges and wherever a roof is over a street.
- The straight bot passes the 90% bar on seeds 1–40 but is weaker on 41–100 (82% vs 100% before). The grid is harder because intersections repeat every 120–200 m with no wall to wall-run on. If players find it harder too, the knobs are `blockLen` and `level.maxGapStart`.
- Slow sideways drift inside an intersection can count as a turn (the 60% rule as specified). The 3 m inset stops it at the very edge, where it used to turn him into the corner tower.
- The street furniture (lamps, cars) jumps to the new street at the switch. The skyline is world-fixed and does not jump.
- Not verified in a real browser with input: hand control maps through the same `aim()`, so it rotates the same way as the keys, but I did not run the webcam.
