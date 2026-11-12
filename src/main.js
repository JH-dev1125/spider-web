import { CFG } from './config.js';
import { createGame, stepGame, createBot } from './game.js';
import { createChargeTracker } from './input-core.js';
import { attachKeyboard } from './keyboard.js';
import { startHand } from './hand.js';
import { handStatusText } from './hand-classify.js';
import { makeCamera, drawFrame } from './render.js';
import { createScore } from './score.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let w = 0, h = 0;

function resize() {
  const dpr = Math.min(CFG.maxDpr, window.devicePixelRatio || 1);
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// Debug: ?autoplay starts at once with the bot; ?autoplay=<sec> stops the bot after <sec> so it dies;
// ?t=<sec> fast-forwards (see the bottom).
const q = new URLSearchParams(location.search);
const autoplay = q.has('autoplay');
const botSec = Number(q.get('autoplay')) || Infinity;

let storage;
try { storage = window.localStorage; } catch { /* blocked: score stays in memory */ }
const score = createScore(storage);
const tracker = createChargeTracker();
const now = () => performance.now() / 1000;

let mode = 'title'; // 'title' | 'play' | 'over'
let g = createGame(Date.now());
let cam = null;
let actions = []; // input queue for stepGame: {type:'press'|'release', ...}
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
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyH' || e.repeat || mode === 'play' || hand === 'loading' || hand === 'on') return;
  hand = 'loading';
  const id = ++attempt;
  const timer = setTimeout(() => { if (attempt === id) { attempt++; hand = 'failed'; } }, CFG.handPromptTimeoutSec * 1000);
  const onError = (err) => { console.warn('hand tracking stopped:', err); hand = 'failed'; handStatus = null; camEl.hidden = true; };
  startHand(camEl, tracker, now, { mode: 'shoot', onShot, onFrame: (st) => { handStatus = st; }, onError })
    .then((ctl) => {
      clearTimeout(timer);
      if (attempt !== id) { ctl.stop(); return; } // answered after the timeout: release the camera
      hand = 'on'; camEl.hidden = false;
    })
    .catch((err) => { clearTimeout(timer); if (attempt === id) { console.warn('hand mode unavailable:', err); hand = 'failed'; } });
});

function start() {
  g = createGame(Date.now());
  cam = null;
  actions = [];
  tracker.cancel(); // a key held through death must not release anything on the first frame
  bot = autoplay ? createBot() : null;
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
      coarse ? ['PC(키보드/웹캠)에서 열어주세요', H.hudPx, H.accent, true] : ['Space: 키보드로 시작', H.hudPx, H.accent, true],
      ['바닥에 닿으면 끝 · 너무 오래 잡고 있으면 뒤로 되돌아가요', H.textPx, H.color],
      hand === 'on' && ['검지·새끼 펴면 발사, 유지하면 스윙, 풀면 날아감 (손 위치 = 방향)', H.textPx, H.color],
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
  ctx.fillText(handStatusText(st), w - H.margin, camEl.getBoundingClientRect().top - H.margin);
}

function update(dt) {
  // open palm on the title or the result screen = Space
  const palmOk = mode === 'title' || (mode === 'over' && overSec >= CFG.overFallSec);
  palmSec = palmOk && handStatus?.open ? palmSec + dt : 0;
  if (palmSec >= CFG.handRestartSec) { palmSec = 0; start(); }
  if (mode === 'title') return;
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
  cam = makeCamera(g.player, cam, dt);
  drawFrame(ctx, w, h, {
    player: g.player,
    buildings: g.world.buildings,
    cam,
    aim: null, // no charge preview: a press fires at once
    missLine: g.missLine,
    pose: g.pose,
    t,
    shake: g.shake,
  });
  drawHud();
  drawHandStatus();
  requestAnimationFrame(frame);
}
if (autoplay) {
  start();
  // ?t=<sec> fast-forwards the autoplay in maxDt steps (headless screenshots barely advance rAF)
  for (let s = 0; s < (Number(q.get('t')) || 0); s += CFG.maxDt) { update(CFG.maxDt); cam = makeCamera(g.player, cam, CFG.maxDt); }
}
requestAnimationFrame(frame);
