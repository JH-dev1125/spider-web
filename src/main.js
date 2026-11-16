import { CFG } from './config.js';
import { createGame, stepGame, createBot } from './game.js';
import { createChargeTracker } from './input-core.js';
import { attachKeyboard } from './keyboard.js';
import { handStatusText, setGestureOverride } from './hand-classify.js';
import { createScore } from './score.js';

const canvas = document.getElementById('game'); // 2D HUD overlay; the 3D scene draws on #gl below it
const ctx = canvas.getContext('2d');
let w = 0, h = 0;
let renderer = null; // three.js loads from a CDN: if it fails, say so instead of a blank screen
import('./render.js')
  .then((m) => { renderer = m.createRenderer(document.getElementById('gl')); resize(); })
  .catch((err) => {
    console.error(err);
    const p = document.body.appendChild(document.createElement('p'));
    p.textContent = `3D 렌더러를 불러오지 못했습니다 (${err.message}). 네트워크를 확인하고 새로고침하세요.`;
    p.style.cssText = 'position:fixed;left:0;right:0;bottom:40px;margin:0;text-align:center;color:#fff;font:16px system-ui';
  });

function resize() {
  const dpr = Math.min(CFG.maxDpr, window.devicePixelRatio || 1);
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderer?.resize(w, h, dpr);
}
window.addEventListener('resize', resize);
resize();

// Debug: ?autoplay starts at once with the bot; ?autoplay=<sec> stops the bot after <sec> so it dies;
// ?t=<sec> fast-forwards (see the bottom); ?autozip makes the bot zip up its ropes.
const q = new URLSearchParams(location.search);
const autoplay = q.has('autoplay');
const botSec = Number(q.get('autoplay')) || Infinity;

let storage;
try { storage = window.localStorage; } catch { /* blocked: score stays in memory */ }
const score = createScore(storage);
const tracker = createChargeTracker();
const now = () => performance.now() / 1000;

let mode = 'title'; // 'title' | 'calib' | 'play' | 'over'
let g = createGame(Date.now());
let actions = []; // input queue for stepGame: {type:'press'|'release'|'zip'|'zipEnd', ...}
let overSec = 0;
let result = null;
let bot = null;

const onShot = (a) => { if (mode === 'play') actions.push(a); };
attachKeyboard(window, tracker, now, onShot);

// Hand mode (H on the title). Keyboard stays live alongside it.
const camEl = document.getElementById('cam');
let hand = 'off'; // 'off' | 'loading' | 'on' | 'failed'
let handStatus = null; // latest createHandController status
let palmSec = 0; // open palm held on title/result
const coarse = window.matchMedia?.('(pointer: coarse)').matches; // phone/tablet: no keyboard, no webcam game
let attempt = 0;
let handStats = null; // startHand stats: camera, latency, brightness, tracking quality
let cal = null; // hand-calibrate.js, loaded with the camera
let calibrated = false;
let calib = null, calibState = null, calibMsgSec = 0; // the K screen's session, its latest state, "done" toast
const handDebug = q.has('handdebug');
function useCalibration(templates) {
  calibrated = !!templates;
  setGestureOverride(templates ? cal.makeOverride(cal.createClassifier(templates)) : null);
}
let prevHands = null;
function onHandFrame(st, hands, stats) {
  handStatus = st; handStats = stats;
  if (mode !== 'calib' || !calib || hands === prevHands) return; // same array = no new camera frame
  prevHands = hands;
  calibState = calib.update(hands, now());
  if (calibState.phase === 'done') {
    useCalibration(cal.saveTemplates(storage, calib.templates));
    calib = null; calibMsgSec = 3; mode = 'title';
  }
}
// Loads the camera code only now: keyboard players never fetch MediaPipe or the calibration code.
function enableHand() {
  if (hand === 'loading' || hand === 'on') return;
  hand = 'loading';
  const id = ++attempt;
  const timer = setTimeout(() => { if (attempt === id) { attempt++; hand = 'failed'; } }, CFG.handPromptTimeoutSec * 1000);
  const onError = (err) => { console.warn('hand tracking stopped:', err); hand = 'failed'; handStatus = null; handStats = null; camEl.hidden = true; };
  Promise.all([import('./hand.js'), import('./hand-calibrate.js')])
    .then(([m, c]) => {
      cal = c;
      useCalibration(cal.loadTemplates(storage));
      return m.startHand(camEl, tracker, now, { mode: 'shoot', onShot, onFrame: onHandFrame, onError, onCamera: () => clearTimeout(timer) });
    })
    .then((ctl) => {
      clearTimeout(timer);
      if (attempt !== id) { ctl.stop(); return; } // answered after the timeout: release the camera
      hand = 'on'; camEl.hidden = false;
    })
    .catch((err) => { clearTimeout(timer); if (attempt === id) { console.warn('hand mode unavailable:', err); hand = 'failed'; } });
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyH' && mode !== 'play' && mode !== 'calib') enableHand();
  else if (e.code === 'KeyK' && mode === 'title' && !coarse) { // calibration screen; turns the camera on if needed
    if (hand === 'failed') hand = 'off';
    enableHand();
    mode = 'calib'; calib = null; calibState = null; // the session starts in update() once the camera is on
  } else if (mode === 'calib' && e.code === 'Escape') { calib = null; mode = 'title'; }
  else if (mode === 'calib' && e.code === 'Delete' && cal) { cal.clearTemplates(storage); useCalibration(null); }
});

function start() {
  g = createGame(Date.now());
  actions = [];
  tracker.cancel(); // a key held through death must not release anything on the first frame
  bot = autoplay ? createBot({ zip: q.has('autozip') }) : null;
  mode = 'play';
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  e.preventDefault();
  if (e.repeat) return;
  if (mode === 'title' || (mode === 'over' && overSec >= overGate)) start();
});

const overGate = Math.max(CFG.overInputDelaySec, CFG.overFallSec); // restart only after the result is on screen
const H = CFG.hud;
function lines(list) { // [text, px, color, bold] stacked around the screen centre
  const step = (px) => px * H.lineGap;
  let y = (h - list.reduce((s, l) => s + step(l[1]), 0)) * 0.5;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const [s, px, color, bold] of list) {
    ctx.font = `${bold ? 'bold ' : ''}${px}px ${H.font}`;
    ctx.fillStyle = color;
    ctx.fillText(s, w * 0.5, y);
    y += step(px);
  }
}

function drawHud() {
  if (mode === 'calib') { drawCalib(); return; }
  ctx.textBaseline = 'top';
  if (mode !== 'title') {
    ctx.font = `bold ${H.hudPx}px ${H.font}`;
    ctx.fillStyle = H.color;
    ctx.textAlign = 'center';
    ctx.fillText(`${mode === 'over' ? result.distance : Math.floor(g.player.pos.z)} m`, w * 0.5, H.margin);
    ctx.font = `${H.textPx}px ${H.font}`;
    ctx.textAlign = 'right';
    ctx.fillText(`BEST ${score.best()} m`, w - H.margin, H.margin);
  }
  const showResult = mode === 'over' && overSec >= CFG.overFallSec;
  if (mode === 'play' || (mode === 'over' && !showResult)) return;
  ctx.fillStyle = H.backdrop;
  ctx.fillRect(0, 0, w, h);
  if (mode === 'title') {
    lines([
      ['WEB RUNNER', H.titlePx, H.color, true],
      ['왼쪽 Q · A · Z   /   오른쪽 E · D · C   (위 · 가운데 · 아래)', H.textPx, H.color],
      ['누르면 즉시 거미줄 → 누르고 있는 동안 스윙 → 떼면 날아감', H.textPx, H.color],
      ['줄이 붙은 채 Space: 줄 당기기 (앵커에 가까워지면 저절로 놓고 날아감)', H.textPx, H.color],
      coarse ? ['PC(키보드/웹캠)에서 열어주세요', H.hudPx, H.accent, true] : ['Space: 키보드로 시작', H.hudPx, H.accent, true],
      ['바닥에 닿으면 끝 · 너무 오래 잡고 있으면 뒤로 되돌아가요', H.textPx, H.color],
      hand === 'on' && ['검지·새끼 펴면 발사, 유지하면 스윙, 풀면 날아감 (미리보기 속 손 위치 = 방향)', H.textPx, H.color],
      hand === 'on' && ['발사 자세로 손을 몸 쪽으로 확 당기면 줄 당기기', H.textPx, H.color],
      !coarse && [calibMsgSec > 0 ? '손 보정 완료!' : calibrated ? 'K: 손 다시 보정 (보정됨)' : 'K: 내 손에 맞게 보정 (인식 정확도 ↑)',
        H.textPx, calibMsgSec > 0 ? H.accent : H.dim],
      {
        off: ['H: 손동작 켜기', H.textPx, H.color],
        loading: ['웹캠 준비 중…', H.textPx, H.dim],
        on: ['손동작 켜짐 · 손바닥을 1초 펴면 시작', H.textPx, H.accent],
        failed: ['웹캠을 쓸 수 없어 키보드로 진행합니다', H.textPx, H.dim],
      }[hand],
    ].filter(Boolean));
  } else {
    lines([
      [`${result.distance} m`, H.titlePx, H.color, true],
      [result.newBest ? 'NEW BEST!' : `BEST ${score.best()} m`, H.hudPx, result.newBest ? H.accent : H.color, true],
      [hand === 'on' ? 'Space / Enter / 손바닥 1초: 다시 하기' : 'Space / Enter: 다시 하기', H.textPx, H.color],
      hand !== 'on' && hand !== 'loading' && ['H: 손동작 켜기', H.textPx, H.dim],
    ].filter(Boolean));
  }
}

const POSE_KO = {
  shoot: ['발사 자세', '검지와 새끼만 펴고 중지·약지는 접기 (평소 쏘는 그대로)'],
  open: ['손바닥', '손가락을 모두 펴고 손바닥을 카메라로'],
  fist: ['주먹', '주먹을 쥐거나 힘을 빼고 편하게 오므린 손'],
};
function drawCalib() { // text above the enlarged preview (#cam.big)
  ctx.fillStyle = H.backdrop;
  ctx.fillRect(0, 0, w, h);
  const s = calibState;
  const list = [['손 보정', Math.round(H.titlePx * 0.6), H.color, true]];
  if (hand === 'failed') list.push(['웹캠을 쓸 수 없습니다 · Esc: 돌아가기', H.textPx, H.dim]);
  else if (hand !== 'on' || !s) list.push(['웹캠 준비 중… 양손을 화면에 보여 주세요', H.textPx, H.dim]);
  else {
    const [name, how] = POSE_KO[s.pose];
    list.push([`${s.index + 1} / 3 · ${name}`, H.hudPx, H.accent, true], [how, H.textPx, H.color],
      [{ wait: '양손을 화면에 보여 주세요', prep: '그대로 유지… 곧 기록합니다', rec: `기록 중 · 양손으로, 조금씩 기울여 주세요 (${s.samples})` }[s.phase], H.textPx, H.color]);
  }
  list.push(['Esc: 취소 · Delete: 저장된 보정 지우기', H.textPx, H.dim]);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let y = h * 0.05;
  for (const [t, px, color, bold] of list) {
    ctx.font = `${bold ? 'bold ' : ''}${px}px ${H.font}`;
    ctx.fillStyle = color;
    ctx.fillText(t, w / 2, y);
    y += px * H.lineGap;
  }
  if (s && s.phase !== 'wait') { // progress: white while settling, accent while recording
    const bw = Math.min(480, w * 0.6);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect((w - bw) / 2, y, bw, 8);
    ctx.fillStyle = s.phase === 'rec' ? H.accent : H.color;
    ctx.fillRect((w - bw) / 2, y, bw * s.progress, 8);
  }
}

const QUALITY_COLOR = { good: '#3ddc84', fair: '#ffd54a', poor: '#ff5c5c', none: '#ff5c5c' };
function drawHandDebug() { // ?handdebug: camera, model and latency numbers, bottom-left
  const s = handStats;
  if (!s) return;
  const c = s.camera, f = (v) => (v == null ? '-' : v.toFixed(1));
  const rows = [
    `camera ${c.width ?? '?'}x${c.height ?? '?'} @ ${f(c.frameRate)} fps (measured ${f(s.fps)}) · resize ${c.resizeMode ?? '-'} · ${c.label || '-'}`,
    `model input ${s.input?.w}x${s.input?.h} on ${s.delegate} · detect ${f(s.detectMs)} ms`,
    `capture → hands ${f(s.frameMs)} ms · capture → last action ${f(s.actionMs)} ms (+ ≤1 game frame)`,
    `quality ${s.quality}${s.edge ? ' · edge' : ''}${s.dark ? ' · DARK' : ''} · calibrated ${calibrated}`,
  ];
  ctx.font = '14px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(8, h - 14 - rows.length * 18, 700, rows.length * 18 + 6);
  ctx.fillStyle = '#9f9';
  rows.forEach((r, i) => ctx.fillText(r, 14, h - 10 - (rows.length - 1 - i) * 18));
}

function drawHandStatus() { // text just above the mirrored preview (bottom-right <video>)
  if (hand !== 'on' && hand !== 'failed') return;
  ctx.font = `bold ${H.textPx}px ${H.font}`;
  ctx.fillStyle = H.color;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  if (hand === 'failed') { // title already shows it in the menu; hidden during play
    if (mode === 'over') ctx.fillText('웹캠을 쓸 수 없어 키보드로 진행합니다', w - H.margin, h - H.margin);
    return;
  }
  const st = handStatus;
  camEl.classList.toggle('big', mode === 'calib');
  camEl.style.outlineColor = QUALITY_COLOR[handStats?.quality ?? 'none']; // tracking confidence at a glance
  const r = camEl.getBoundingClientRect();
  const warn = handStats?.dark ? '너무 어두워요 · 조명을 켜 주세요' : handStats?.edge ? '손을 화면 가운데로' : null;
  if (warn) {
    ctx.fillStyle = QUALITY_COLOR.fair;
    ctx.fillText(warn, w - H.margin, r.top - H.margin - H.textPx * H.lineGap);
    ctx.fillStyle = H.color;
  }
  if (mode === 'calib') return; // the calibration screen has its own text
  ctx.fillText(handStatusText(st), w - H.margin, r.top - H.margin);
  // zone guides over the preview: left/right half and the hi/mid/lo cuts the game actually uses
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(r.left + r.width / 2, r.top); ctx.lineTo(r.left + r.width / 2, r.bottom);
  for (const k of CFG.handLevelCuts) { ctx.moveTo(r.left, r.top + r.height * k); ctx.lineTo(r.right, r.top + r.height * k); }
  ctx.stroke();
}

function update(dt) {
  // open palm on the title or the result screen = Space
  const palmOk = mode === 'title' || (mode === 'over' && overSec >= CFG.overFallSec);
  palmSec = palmOk && handStatus?.open ? palmSec + dt : 0;
  if (palmSec >= CFG.handRestartSec) { palmSec = 0; start(); }
  calibMsgSec = Math.max(0, calibMsgSec - dt);
  if (mode === 'calib' && !calib && cal && hand === 'on') calib = cal.createCalibrationSession({ prepSec: 1.5, recordSec: 2 });
  if (mode === 'title' || mode === 'calib') return;
  if (bot && g.elapsed < botSec) actions.push(...bot(g, dt));
  const events = stepGame(g, dt, actions);
  actions = [];
  if (mode === 'play' && events.includes('dead')) {
    mode = 'over';
    overSec = 0;
    tracker.cancel();
    const distance = Math.floor(g.player.pos.z);
    result = { distance, newBest: score.submit(distance) };
  } else if (mode === 'over') overSec += dt;
}

let last = now();
function frame() {
  const t = now();
  const dt = Math.min(CFG.maxDt, t - last); // also keeps a tab switch from becoming one huge step
  last = t;
  update(dt);
  renderer?.render({
    player: g.player,
    structures: g.world.structures,
    web: g.web,
    missLine: g.missLine,
    pose: q.get('debugPose') || g.pose, // ?debugPose=<name> pins a pose for screenshots
    t,
    shake: g.shake,
  }, dt);
  ctx.clearRect(0, 0, w, h);
  drawHud();
  drawHandStatus();
  if (handDebug) drawHandDebug();
  requestAnimationFrame(frame);
}
if (autoplay) {
  start();
  // ?t=<sec> fast-forwards the autoplay in maxDt steps (headless screenshots barely advance rAF)
  for (let s = 0; s < (Number(q.get('t')) || 0); s += CFG.maxDt) update(CFG.maxDt);
}
if (q.has('calib')) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK' })); // ?calib: open the K screen (screenshots)
requestAnimationFrame(frame);
