# REPORT — hand-pro (webcam hand-tracking pipeline)

Branch `JH-dev1125/hand-pro`. `node --test tests/*.test.js`: **154 pass, 0 fail**. That count includes the 21 new tests in `hand-filter.test.js`, `hand-calibrate.test.js` and the new camera tests in `hand.test.js`. The existing hand tests are unchanged and pass.

## What changed

| File | Change |
|---|---|
| `src/hand.js` | Camera ladder (`openCamera`), exposure hint, track settings read back, model-input sizing, tuned confidences, One Euro smoothing, quality / edge / darkness check, latency stats, `onCamera` callback |
| `src/hand-filter.js` (new, pure) | `createOneEuro`, `createHandsFilter` (per-hand state, 2D + world), `handQuality` |
| `src/hand-calibrate.js` (new, pure) | Features, k-NN classifier with out-of-distribution rejection, blend with the rules, localStorage templates, calibration state machine |
| `src/hand-classify.js` | **Hook only** (see below). `createHandController` is untouched |
| `src/main.js` | Hand code loads lazily on H/K. K calibration screen, preview border colour, warnings, `?handdebug` overlay, `?calib` |
| `index.html` | Preview outline and `#cam.big` (enlarged preview during calibration) |
| `src/config.js` | `handMinConfidence` is replaced by `handDetectConf` / `handPresenceConf` / `handTrackConf`. New keys: `handDetectMaxW`, `handDarkLuma` |
| `spike/hand.html` | Camera settings, raw (grey) vs filtered (blue) dots, calibrated class with probabilities and distance, latency, border colour |

## Hook lines (for merging with dual-rope)

- `src/hand-classify.js:48-49`: `let gestureOverride = null; export const setGestureOverride = (fn) => …`
- `src/hand-classify.js:54-55`: `const rule = gestureFromBends(bends, prev); const gesture = gestureOverride ? gestureOverride(world ?? lms, rule) : rule;`
- `src/hand.js:93`: `const smooth = createHandsFilter();`
- `src/hand.js:113-115`: `detectForVideo(small ?? video, t0)` → `smooth(…, frameT / 1000)`. The controller receives the **smoothed** hands, and each hand has a new `raw` and `quality` field.
- `src/hand.js:146`: `frameT` comes from rVFC `captureTime`.
- `onFrame(status, hands, stats)` gains a third argument. `startHand` also returns `stats`.

Whatever the dual-rope rewrite does inside `createHandController`, it keeps the calibration as long as it still calls `classifyHand`. The override is module-level, so no new parameter has to be passed through.

## Model choice and why

- **HandLandmarker, float16 `hand_landmarker.task` (kept). GPU delegate with CPU fallback (kept).** I checked the model bucket: `float32`, `int8` and a separate `hand_landmarker_full` all return 404. The only published Tasks hand model is this bundle, which already contains the *full* palm detector and the full 21-point landmark model. No heavier model exists to switch to.
- **Accuracy comes from the input instead.** The camera now delivers up to 1280x720 at its native mode (`resizeMode: 'none'`), and that full frame is fed to the model. MediaPipe crops the hand region from the source frame, so a small or distant hand gets a sharper 224 px crop than it did from the old 640x480.
- **GestureRecognizer: not used. Decided from what it can and cannot do; not measured on real hands.**
  1. Its fixed vocabulary is None / Closed_Fist / Open_Palm / Pointing_Up / Thumb_Up / Thumb_Down / Victory / ILoveYou. The thwip is closest to `ILoveYou`, but that label requires the thumb out, and many people tuck the thumb for a thwip. It would disagree with exactly the poses we need.
  2. It runs its own copy of the hand landmarker. Running it "alongside" means two full inferences per frame, roughly doubling detection time and pushing past the 60 ms latency target.
  3. Personal calibration solves the same problem, "the rules don't match my hand", with the user's own pose.
- **Confidences:** detection 0.5 (fewer ghost palms), presence 0.6 (high, drops blurred ghosts), tracking 0.3 (low, so fewer re-detections and less churn). Before, all three were 0.35. `handLostMs` (300 ms) still covers brief dropouts.
- **The MediaPipe CDN stays at 0.10.14.** npm now has 1.2.3, a major version I could not check against a real camera. I left it for a separate change.

## Camera

- The ladder asks for 1280x720, then 960x540, then 640x480 (each with `min` = that size), then "anything". Every rung requests `facingMode: 'user'`, `frameRate: {ideal: 60}` and `resizeMode: {ideal: 'none'}` (no browser crop or rescale). Only `OverconstrainedError` moves down the ladder. A denied permission fails immediately, so the user is not prompted three times. This is tested with a fake `getUserMedia`.
- `track.getSettings()` plus the device label go into `stats.camera` and the debug overlay.
- **Exposure hint:** when `getCapabilities()` allows it, `applyConstraints({advanced:[{exposureMode:'continuous', whiteBalanceMode:'continuous'}]})`.
- **Model input:** the frame as is up to `handDetectMaxW` = 1280 wide. A wider frame is first scaled down on an OffscreenCanvas.
- requestVideoFrameCallback is kept, and the rAF fallback is unchanged.
- Fix found during verification: the existing 15 s "permission prompt timeout" also covered the model download. On slow machines it gave up and released the camera even though access had been granted. The timer is now cleared at `onCamera`, the moment the permission is answered.

## Smoothing (One Euro, `src/hand-filter.js`)

| | minCutoff | beta | dCutoff | Jitter σ kept | Step reached after 1 / 2 / 3 frames | Lag on a constant-speed move |
|---|---|---|---|---|---|---|
| 2D (screen fraction) | 1.5 Hz | 8 | 1 Hz | 34 % | 53 / 81 / 92 % | ~11 ms at 1 screen/s |
| World (metres) | 1.5 Hz | 40 | 1 Hz | 40 % | 57 / 84 / 94 % | ~6 ms at 0.5 m/s |

All figures are from synthetic 60 fps tracks. The filter runs on each coordinate of each landmark, separately for each hand. Hands are told apart by matching wrist positions, the same way the controller does it. Tests cover: jitter falls by more than half, a step is followed within 4 frames, and a zip-style pull (size −25 % in 120 ms) still shows the 18 % drop inside the 250 ms zip window.

## Personal calibration

- **Flow:** K on the title (or `?calib`) opens it, and it turns on the camera if it is off. The preview enlarges to the centre. There are 3 poses: **발사 자세 (thwip) → 손바닥 (open palm) → 주먹 or a relaxed, curled hand**. For each pose the user shows the hand, holds it for 1.5 s to settle, then the pose is recorded for 2 s. The prompt asks for both hands and a slight tilt. Every visible hand is sampled on every camera frame. Esc cancels, and Delete clears the saved calibration. On finish, the title shows "손 보정 완료!" ("calibration done") and later reads "K: 손 다시 보정 (보정됨)" ("recalibrate; calibrated").
- **Features (19):** the 4 finger bends plus a thumb bend (/90°); 10 fingertip-to-fingertip distances plus thumb tip to index MCP, each divided by palm size; and the palm normal ×0.3. Weighting the normal down keeps the hand's rotation from deciding the class. Computed from world landmarks.
- **Classifier:** distance-weighted k-NN with k=7. A sample is **out of distribution** if it lies farther from every template than 3× the median leave-one-out nearest-neighbour distance, with a floor of 0.25. Out-of-distribution samples go to the rules.
- **Blend:** 0.65 × k-NN probability + 0.35 × rule vote, and the winner needs ≥ 0.6. The user's own templates alone can therefore turn a rule "none" into "shoot". A disagreement where the k-NN vote is split reads "none". With no calibration, the rules alone decide.
- **Storage:** `localStorage['webrunner.handCalib.v1']`, at most 90 templates per pose. On load the shape is checked (lengths, finite numbers), and anything malformed counts as "not calibrated".
- **Synthetic results** (trained on ±15° and scale 0.9-1.1, tested on held-out samples at ±35° and scale 0.6-1.6, 500 per class):

| Pose | k-NN accuracy | Rules alone |
|---|---|---|
| Lazy thwip | 100 % | 0 % (the rules say "none") |
| Open palm | 100 % | 95.4 % |
| Fist | 100 % | 100 % |

  An uncalibrated "V" pose is flagged out of distribution, so it falls back to the rules. Classifying one frame takes ~0.02 ms.

## Robustness / HUD

- **Preview border** shows tracking quality: green when the handedness score is ≥ 0.9 and the hand is not at the edge; yellow when ≥ 0.7 or at the edge; red when lower or when there is no hand. The Tasks JS API does not expose the presence score, so the handedness score stands in for it.
- **"손을 화면 가운데로" ("move your hand to the centre")** appears when a raw landmark is within 3 % of the frame border.
- **"너무 어두워요 · 조명을 켜 주세요" ("too dark, turn on a light")** appears when the mean luma of a 32x18 thumbnail, sampled every 15 frames, is below 0.18.

## Latency

- **Measured:**
  - `frameMs` runs from camera capture (rVFC `captureTime`, falling back to `receiveTime` or arrival) until the hands are classified.
  - `actionMs` runs from capture to the last `onShot`. The game applies the action on its next frame (≤ 16.7 ms more).
  - Both appear in `?handdebug` and in the spike, along with detect ms and measured fps.
- **Headless Edge numbers (not meaningful for hardware):** fake camera, 1280x720 at 20 fps, "GPU" delegate (= SwiftShader software GL). Detection took 150-440 ms, so these say nothing about a real GPU.
- **Real hardware has not been measured.** I estimate, without measuring, at 60 fps on a typical laptop GPU:
  - camera capture to frame delivered ≈ 10 ms
  - detect ≈ 8-15 ms for 2 hands
  - the 2-frame press gate adds +17 ms
  - filter lag ≈ 5-10 ms
  - the game frame adds ≤ 17 ms
  - **Total ≈ 55-70 ms.**

  That is about the ~60 ms target. **The coordinator should read `?handdebug` on a real webcam.**

## Verification

`python -m http.server 8034` plus headless Edge with a fake camera. Screenshots are in `C:\Users\jhgim\OneDrive\Desktop\MyGame\.superpowers\shots\`:

- `handpro-title.png`: the title shows the new K line, with no load errors.
- `handpro-calib.png` (`?calib&handdebug`): the calibration screen at "1 / 3 · 발사 자세", the enlarged preview with its quality border, and the debug panel (camera 1280x720, GPU, latency).
- `handpro-spike.png`: the spike page with camera, model and latency stats and the border.

With `--virtual-time-budget`, even a plain `getUserMedia` never resolved in this Edge, so the screenshots only showed "loading". I took the final screenshots over the DevTools protocol after 20-25 s of real time. The console showed no exceptions, and MediaPipe logged "Graph successfully started running". Only my own server and headless Edge were stopped.

## Concerns

1. **No real hands or real camera were tested.** The thresholds, filter parameters and k-NN reject rule come from synthetic data. The real-world thwip, real latency and the darkness threshold (0.18) all need a person in front of a webcam.
2. **Presence 0.6 / tracking 0.3** is the requested direction, but a higher presence threshold can drop hands more often in poor light. If hands flicker out, lower `handPresenceConf` toward 0.5 first.
3. **The calibration "fist" class also takes the relaxed, curled hand** (one class, as the spec allowed). In `fist` mode (spike only) a relaxed hand could count as the hold gesture.
4. **While a web is held, release is still judged by the rules** (`stillHolding` on bends). Calibration changes when a press starts, and what the HUD shows, but not when the rope lets go.
5. **The controller now gets smoothed landmarks.** Zip detection keeps the 18 % / 250 ms threshold (tested synthetically), but the zip feel should be checked by hand.
6. **The `?handdebug` panel overlaps the enlarged preview** on the calibration screen at 720 p. It is cosmetic and debug-only.
7. **Merging:** `main.js` (hand start, keydown, HUD) and `config.js` (hand keys) are likely to conflict with the dual-rope branch. The changes are confined to the hand section.
