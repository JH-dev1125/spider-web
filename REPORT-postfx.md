# REPORT: speed post-processing (branch JH-dev1125/speed-postfx)

Goal: look like the reference dive and fast swings (sheet1 frames 6-10): the frame edges stream along the direction of travel, the hero stays sharp, a modest FOV widening, and a vignette.

## Files
- `src/postfx.js`: `createPostFX(THREE, renderer, scene, camera) -> { render(view, dt), resize(w, h, dpr), setEnabled(bool) }`
- `src/postfx-math.js`: pure curves (`fxTargets`, `ease`) and the auto-disable guard (`createFrameGuard`)
- `tests/postfx.test.js`: 6 tests covering the curves, the dt easing and the guard

## Hook lines in src/render.js (3)
```js
import { createPostFX } from './postfx.js';                 // with the other imports
const postfx = createPostFX(THREE, gl, scene, camera);      // after the camera is created
postfx.render(view, dt);                                    // replaces gl.render(scene, camera)
```
render.js's `resize` did not need a hook. postfx resizes its target when `renderer.getDrawingBufferSize` changes, so it follows pixel-ratio and size changes on its own.

## Shader approach
- The scene renders into one `WebGLRenderTarget` at drawing-buffer size, 8-bit sRGB (no banding, no float formats). It uses 4x MSAA only when the canvas itself is antialiased, to match render.js's AA rule. Logarithmic depth is unaffected because the scene pass keeps its own depth buffer. The quad has no depth test and does not include the logdepth chunks.
- One full-screen pass draws a quad with a `ShaderMaterial`:
  - **Radial blur, 12 taps**, toward the **focus of expansion**: the velocity direction projected on screen, eased, falling back to the centre when moving away from the view. In a dive the streaks come out of the street's vanishing point. In a sideways swing the focus moves off-centre, so the edges smear in the direction of travel.
  - **Mask**: `smoothstep(0.12, 0.75)` of the distance from the focus, multiplied by `smoothstep(0.1, 0.3)` of the distance from the **projected hero**. Without the second term the hero got smeared whenever he was away from the focus (fx-fall, iteration 1).
  - Per-pixel dither on the tap offsets to hide the step ghosting. Pixels with mask ≈ 0, including the hero and centre, skip the loop (dynamic branch), so they cost 3 taps.
  - **Chromatic aberration**: R and B offset radially by `0.006 * blur * d`, only on the centre tap (2 extra fetches).
  - **Vignette**: 0.22 constant, up to 0.40 at full blur.
- Bloom-lite was skipped: it needs a second, downsampled pass, which is too much cost for the effect.
- **FOV kick**: `camera.fov += kick` only for the scene render, then restored. render.js's own 60-68° speed fov is untouched. The kick is at most **+8°** (tests assert ≤ 10), so the widest view is 76°. It comes only at |v| > 27 m/s (full at 38) or in dives (-vy 10 → 26), and eases in at 5/s and out at 2/s.
- Curves (postfx-math.js `FX`) are tuned to measured bot speeds: swings peak at about 29 m/s at the bottom and dives reach -vy 25-32. Blur: speed 21 → 32 m/s gives up to 0.75, a dive gives up to 1.0.
- **Zip-launch kick**: not added. game.js already sets `g.shake = shakePeak` on `'zipped'`, and render.js applies view.shake.

## Off switches
- `?nofx`: plain `renderer.render`, no kick and no target. This is the original path.
- Auto-disable: wall-clock frame time is smoothed (EMA 0.1) and checked against 20 ms. After 2 s continuously over, the pass turns off permanently (the FOV kick stays) and a `console.warn` is logged. Single hitches over 250 ms, such as tab switches, are ignored.
- `setEnabled(false)` does the same at runtime.

## Cost
- **Not measured on a real GPU.** Headless swiftshader has no timer queries, and its frame times say nothing about a GPU.
- Estimate for 1280x720: about 0.9 M pixels × at most 15 fetches, from a texture that is cache-friendly for radial reads. Pixels in the sharp mask cost 3 fetches. That should be roughly **0.2-0.5 ms on an integrated GPU**, plus the MSAA resolve and one extra target clear.
- At dpr 2 (4x the pixels) it is about 4x that. This is the case the auto-disable guard covers.
- `?stats` still counts everything: `info.autoReset` is off and postfx resets it once per frame, so the counter shows scene + quad (27 calls in fx-dive).

## Screenshots (.superpowers/shots/)
- `fx-dive.png` / `fx-dive-nofx.png`: `?autoplay&t=3.6&seed=7`, the opening dive.
- `fx-swing.png`: `t=5.3`, the bottom of a fast swing, focus off-centre.
- `fx-fall.png` / `fx-fall-nofx.png`: `?autoplay=5&t=20`, released and free-falling down a street canyon, -vy ≈ 32.

Iterations:
1. Thresholds tuned to guessed speeds (28-55 m/s) produced no blur in swings. Retuned to the measured speeds.
2. The hero was smeared in the fall. Added the hero mask.
3. Raised taps from 10 to 12 and fixed the stats counter.

The result matches the reference beat: smeared edges, a sharp hero and a slightly wider view. It is less smooth than a real motion-vector blur.

## Concerns
- **The blur is screen-space radial, not per-object motion blur**, so streaks come out of the focus even when the camera rotates rather than translates. This is fine for dives and swings.
- **Headless screenshots sometimes come out black.** It happens with 5 parallel Edge instances, and occasionally even alone. A retry renders, and the console shows no errors, so it is load timing in `--virtual-time-budget`, not the effect.
- **The speed thresholds are absolute m/s.** If the physics rewrite on main changes speeds a lot, retune `FX` in postfx-math.js.
- **Interaction with the camera rewrite on main**: postfx reads only `camera.fov`/position after render.js sets them, plus `view.player.pos` and `vel`, so merging should be clean unless `gl.render(scene, camera)` moves.
- **The camera is not pointing down during the dive.** The reference frames show a top-down dive camera; ours looks along the street. That belongs to the camera/hero session.
