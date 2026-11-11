// Webcam hand control. The only file that loads anything from outside (MediaPipe from the CDN).
import { createHandController, mirror } from './hand-classify.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// opts: mode 'shoot'|'fist' (charge gesture), onRelease(shot) like attachKeyboard's,
// onFrame(status, hands) per processed video frame (hands carry mirrored landmarks).
// Rejects if there is no camera, permission is denied, or MediaPipe fails to load.
// Resolves to {stop(), setMode(mode)}.
export async function startHand(video, tracker, now, opts = {}) {
  const { onRelease = () => {}, onFrame = () => {} } = opts;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  let landmarker;
  try {
    const { FilesetResolver, HandLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL },
      runningMode: 'VIDEO',
      numHands: 2,
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    stream.getTracks().forEach((tr) => tr.stop());
    landmarker?.close();
    throw e;
  }

  let ctrl = createHandController(tracker, { mode: opts.mode, onRelease });
  let raf = 0, lastVideoTime = -1, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    ctrl.update([], Infinity); // drops every hand: cancels a charge in progress
    stream.getTracks().forEach((tr) => tr.stop());
    video.srcObject = null;
    landmarker.close();
  };
  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (video.currentTime === lastVideoTime) return; // no new camera frame yet
    lastVideoTime = video.currentTime;
    try {
      const r = landmarker.detectForVideo(video, performance.now());
      const hands = r.landmarks.map((lm, i) => ({ landmarks: mirror(lm), handedness: r.handedness[i]?.[0]?.categoryName }));
      onFrame(ctrl.update(hands, now()), hands);
    } catch (e) {
      console.warn('hand tracking stopped:', e);
      stop();
    }
  };
  raf = requestAnimationFrame(loop);
  return {
    stop,
    setMode(mode) { ctrl.update([], Infinity); ctrl = createHandController(tracker, { mode, onRelease }); },
  };
}
