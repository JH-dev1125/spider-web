// Webcam hand control. The only file that loads anything from outside (MediaPipe from the CDN).
import { CFG } from './config.js';
import { createHandController, mirror } from './hand-classify.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// opts: mode 'shoot'|'fist' (hold gesture), onShot(action) like attachKeyboard's,
// onFrame(status, hands) on every new video frame and every animation frame
// (hands = latest detection: {landmarks (mirrored), world, handedness {categoryName, score}}),
// onError(err) once if tracking dies after start (it has already stopped and released any rope).
// Rejects if there is no camera, permission is denied, or MediaPipe fails to load.
// Resolves to {stop(), setMode(mode)}.
export async function startHand(video, tracker, now, opts = {}) {
  const { onShot = () => {}, onFrame = () => {}, onError = (e) => console.warn('hand tracking stopped:', e) } = opts;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
  // small frames upload faster (the model works at ~224 px anyway); 60 fps halves the wait for a frame if offered
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } }, audio: false,
  });
  let landmarker;
  try {
    const { FilesetResolver, HandLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const c = CFG.handMinConfidence;
    const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2, // 1 would let a resting hand steal tracking from the one that shoots
      minHandDetectionConfidence: c, minHandPresenceConfidence: c, minTrackingConfidence: c,
    });
    try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    stream.getTracks().forEach((tr) => tr.stop());
    landmarker?.close();
    throw e;
  }

  let ctrl = createHandController(tracker, { mode: opts.mode, onShot });
  let raf = 0, vfc = 0, lastVideoTime = -1, stopped = false, hands = [];
  const perFrame = typeof video.requestVideoFrameCallback === 'function'; // detect the moment a frame arrives
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    if (perFrame) video.cancelVideoFrameCallback?.(vfc);
    ctrl.update([], Infinity); // drops every hand: releases a held rope
    stream.getTracks().forEach((tr) => tr.stop());
    video.srcObject = null;
    landmarker.close();
  };
  // fresh = a new camera image to detect on. Without one, update([]) still ages hands out and
  // releases a lost hand's rope (camera slow or stalled). Synchronous: nothing awaits per frame.
  const step = (fresh) => {
    try {
      if (fresh) {
        const r = landmarker.detectForVideo(video, performance.now());
        hands = r.landmarks.map((lm, i) => ({ landmarks: mirror(lm), world: r.worldLandmarks?.[i], handedness: r.handedness[i]?.[0] }));
      }
      const st = ctrl.update(fresh ? hands : [], now());
      if (!st.hands) hands = [];
      onFrame(st, hands);
    } catch (e) {
      stop();
      onError(e);
    }
  };
  const onVideoFrame = () => {
    if (stopped) return;
    vfc = video.requestVideoFrameCallback(onVideoFrame);
    step(true);
  };
  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    const fresh = !perFrame && video.currentTime !== lastVideoTime;
    lastVideoTime = video.currentTime;
    step(fresh);
  };
  if (perFrame) vfc = video.requestVideoFrameCallback(onVideoFrame);
  raf = requestAnimationFrame(loop);
  return {
    stop,
    setMode(mode) { ctrl.update([], Infinity); ctrl = createHandController(tracker, { mode, onShot }); },
  };
}
