// Webcam hand control. The only file that loads anything from outside (MediaPipe from the CDN).
// main.js imports it lazily (H / K), so keyboard play never downloads the model or opens the camera.
import { CFG } from './config.js';
import { createHandController, mirror } from './hand-classify.js';
import { createHandsFilter, handQuality } from './hand-filter.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
// The only hand model Google publishes for the Tasks API (float32/int8/"full" variants 404): full palm
// detector + full 21-point landmark model, float16. See REPORT-handpro.md for why not GestureRecognizer.
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Best stream first. resizeMode 'none' asks for a native camera mode (no browser crop/rescale), so the
// landmark model gets the sharpest crop of a small, far hand. Each rung must at least reach its size.
export const CAMERA_LADDER = [[1280, 720], [960, 540], [640, 480]];
export async function openCamera(md) {
  for (const [width, height] of CAMERA_LADDER) {
    try {
      const stream = await md.getUserMedia({ audio: false, video: {
        facingMode: 'user', width: { min: width, ideal: width }, height: { min: height, ideal: height },
        frameRate: { ideal: 60 }, resizeMode: { ideal: 'none' },
      } });
      return withSettings(stream);
    } catch (e) {
      if (e?.name !== 'OverconstrainedError' && e?.name !== 'ConstraintNotSatisfiedError') throw e; // denied, no camera...
    }
  }
  return withSettings(await md.getUserMedia({ audio: false, video: { facingMode: 'user' } })); // whatever it has
}
function withSettings(stream) {
  const track = stream.getVideoTracks?.()[0];
  // brief exposure hint: continuous auto exposure / white balance where the camera lets the page ask
  const caps = track?.getCapabilities?.() ?? {};
  const hint = {};
  if (caps.exposureMode?.includes('continuous')) hint.exposureMode = 'continuous';
  if (caps.whiteBalanceMode?.includes('continuous')) hint.whiteBalanceMode = 'continuous';
  if (Object.keys(hint).length) track.applyConstraints({ advanced: [hint] }).catch(() => {});
  return { stream, settings: { ...(track?.getSettings?.() ?? {}), label: track?.label ?? '' } };
}

const ema = (old, v, k = 0.1) => (old == null ? v : old + k * (v - old));
const RANK = { none: 0, poor: 1, fair: 2, good: 3 };

// opts: mode 'shoot'|'fist' (hold gesture), onShot(action) like attachKeyboard's,
// onFrame(status, hands, stats) on every new video frame and every animation frame
// (hands = latest detection, smoothed: {landmarks (mirrored), world, raw (unsmoothed landmarks),
// handedness {categoryName, score}, quality {level, edge}}; stats: see below),
// onCamera(settings) once the camera is granted (before the model loads),
// onError(err) once if tracking dies after start (it has already stopped and released any rope).
// Rejects if there is no camera, permission is denied, or MediaPipe fails to load.
// Resolves to {stop(), setMode(mode), stats}.
// stats: camera (actual track settings), delegate, input {w, h} fed to the model, detectMs, frameMs
// (camera capture -> hands classified), actionMs (capture -> the last onShot), fps, dark, quality, edge.
export async function startHand(video, tracker, now, opts = {}) {
  const { onShot = () => {}, onFrame = () => {}, onError = (e) => console.warn('hand tracking stopped:', e) } = opts;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
  const { stream, settings } = await openCamera(navigator.mediaDevices);
  opts.onCamera?.(settings); // permission answered: what follows is the model download, not a prompt
  const stats = { camera: settings, delegate: null, input: null, detectMs: null, frameMs: null, actionMs: null, fps: null, dark: false, quality: 'none', edge: false };
  let landmarker;
  try {
    const { FilesetResolver, HandLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2, // 1 would let a resting hand steal tracking from the one that shoots
      minHandDetectionConfidence: CFG.handDetectConf,
      minHandPresenceConfidence: CFG.handPresenceConf,
      minTrackingConfidence: CFG.handTrackConf,
    });
    try { landmarker = await make('GPU'); stats.delegate = 'GPU'; } catch { landmarker = await make('CPU'); stats.delegate = 'CPU'; }
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    stream.getTracks().forEach((tr) => tr.stop());
    landmarker?.close();
    throw e;
  }

  // Model input: the frame itself up to handDetectMaxW wide (MediaPipe crops the hand from it at full
  // resolution); a wider camera is scaled down first so the upload does not eat the frame budget.
  const vw = settings.width || video.videoWidth || 640, vh = settings.height || video.videoHeight || 480;
  const k = Math.min(1, CFG.handDetectMaxW / vw);
  const Off = globalThis.OffscreenCanvas;
  const small = k < 1 && Off ? new Off(Math.round(vw * k), Math.round(vh * k)) : null;
  const smallCtx = small?.getContext('2d');
  stats.input = { w: Math.round(vw * (small ? k : 1)), h: Math.round(vh * (small ? k : 1)) };
  const lum = Off ? new Off(32, 18).getContext('2d', { willReadFrequently: true }) : null;

  let frameT = 0, lastFrameT = 0, nFrames = 0;
  const shot = (a) => { stats.actionMs = performance.now() - frameT; onShot(a); };
  let ctrl = createHandController(tracker, { mode: opts.mode, onShot: shot });
  const smooth = createHandsFilter();
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
        const t0 = performance.now();
        if (small) smallCtx.drawImage(video, 0, 0, small.width, small.height);
        const r = landmarker.detectForVideo(small ?? video, t0);
        stats.detectMs = ema(stats.detectMs, performance.now() - t0);
        hands = smooth(r.landmarks.map((lm, i) => ({ landmarks: mirror(lm), world: r.worldLandmarks?.[i], handedness: r.handedness[i]?.[0] })), frameT / 1000);
        for (const h of hands) h.quality = handQuality(h.raw, h.handedness?.score);
        stats.quality = hands.reduce((q, h) => (RANK[h.quality.level] > RANK[q] ? h.quality.level : q), 'none');
        stats.edge = hands.some((h) => h.quality.edge);
        if (lum && nFrames++ % 15 === 0) { // ~4 times a second: mean luma of a 32x18 thumbnail
          lum.drawImage(video, 0, 0, 32, 18);
          const d = lum.getImageData(0, 0, 32, 18).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          stats.dark = s / (d.length / 4) / 255 < CFG.handDarkLuma;
        }
      }
      const st = ctrl.update(fresh ? hands : [], now());
      if (!st.hands) { hands = []; stats.quality = 'none'; stats.edge = false; }
      if (fresh) stats.frameMs = ema(stats.frameMs, performance.now() - frameT);
      onFrame(st, hands, stats);
    } catch (e) {
      stop();
      onError(e);
    }
  };
  // frameT: when the camera captured the frame (rVFC metadata), so the latency includes the browser's
  // own decode/queue time, not just ours. Older browsers lack captureTime: fall back to arrival.
  const markFrame = (t) => {
    if (lastFrameT) stats.fps = ema(stats.fps, 1000 / Math.max(1, t - lastFrameT));
    lastFrameT = t;
    frameT = t;
  };
  const onVideoFrame = (nowTs, meta) => {
    if (stopped) return;
    vfc = video.requestVideoFrameCallback(onVideoFrame);
    markFrame(meta?.captureTime ?? meta?.receiveTime ?? nowTs ?? performance.now());
    step(true);
  };
  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    const fresh = !perFrame && video.currentTime !== lastVideoTime;
    lastVideoTime = video.currentTime;
    if (fresh) markFrame(performance.now());
    step(fresh);
  };
  if (perFrame) vfc = video.requestVideoFrameCallback(onVideoFrame);
  raf = requestAnimationFrame(loop);
  return {
    stop,
    stats,
    setMode(mode) { ctrl.update([], Infinity); ctrl = createHandController(tracker, { mode, onShot: shot }); },
  };
}
