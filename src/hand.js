// Webcam hand control. The only file that loads anything from outside (MediaPipe from the CDN).
import { createHandController, mirror } from './hand-classify.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// opts: mode 'shoot'|'fist' (hold gesture), onShot(action) like attachKeyboard's,
// onFrame(status, hands) every animation frame (hands = latest detection, mirrored landmarks),
// onError(err) once if tracking dies after start (it has already stopped and released any rope).
// Rejects if there is no camera, permission is denied, or MediaPipe fails to load.
// Resolves to {stop(), setMode(mode)}.
export async function startHand(video, tracker, now, opts = {}) {
  const { onShot = () => {}, onFrame = () => {}, onError = (e) => console.warn('hand tracking stopped:', e) } = opts;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  let landmarker;
  try {
    const { FilesetResolver, HandLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
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
  let raf = 0, lastVideoTime = -1, stopped = false, hands = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    ctrl.update([], Infinity); // drops every hand: releases a held rope
    stream.getTracks().forEach((tr) => tr.stop());
    video.srcObject = null;
    landmarker.close();
  };
  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    try {
      const fresh = video.currentTime !== lastVideoTime;
      if (fresh) {
        lastVideoTime = video.currentTime;
        const r = landmarker.detectForVideo(video, performance.now());
        hands = r.landmarks.map((lm, i) => ({ landmarks: mirror(lm), handedness: r.handedness[i]?.[0]?.categoryName }));
      }
      // no new image (camera slow or stalled): update([]) still ages hands out and releases a lost hand's rope
      const st = ctrl.update(fresh ? hands : [], now());
      if (!st.hands) hands = [];
      onFrame(st, hands);
    } catch (e) {
      stop();
      onError(e);
    }
  };
  raf = requestAnimationFrame(loop);
  return {
    stop,
    setMode(mode) { ctrl.update([], Infinity); ctrl = createHandController(tracker, { mode, onShot }); },
  };
}
