import { CFG } from './config.js';
import { createGame, stepGame, createBot } from './game.js';
import { createChargeTracker } from './input-core.js';
import { attachKeyboard } from './keyboard.js';
import { startHand } from './hand.js';
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
let shots = [];
let overSec = 0;
let result = null;
let bot = null;

const onShot = (shot) => { if (mode === 'play') shots.push(shot); };
attachKeyboard(window, tracker, now, onShot);

// Hand mode (H on the title). Keyboard stays live alongside it.
const camEl = document.getElementById('cam');
let hand = 'off'; // 'off' | 'loading' | 'on' | 'failed'
let handStatus = null; // latest createHandController status
let palmSec = 0; // open palm held on title/result
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyH' || e.repeat || mode !== 'title' || hand === 'loading' || hand === 'on') return;
  hand = 'loading';
  const onError = (err) => { console.warn('hand tracking stopped:', err); hand = 'failed'; handStatus = null; camEl.hidden = true; };
  startHand(camEl, tracker, now, { mode: 'shoot', onRelease: onShot, onFrame: (st) => { handStatus = st; }, onError })
    .then(() => { hand = 'on'; camEl.hidden = false; })
    .catch((err) => { console.warn('hand mode unavailable:', err); hand = 'failed'; });
});

function start() {
  g = createGame(Date.now());
  cam = null;
  shots = [];
  tracker.cancel(); // a key held through death must not fire on the first frame
  bot = autoplay ? createBot() : null;
  mode = 'play';
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  e.preventDefault();
  if (e.repeat) return;
  if (mode === 'title' || (mode === 'over' && overSec >= CFG.overInputDelaySec)) start();
});

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
      ['길게 누를수록 거미줄이 멀리 나갑니다', H.textPx, H.color],
      ['Space: 키보드로 시작', H.hudPx, H.accent, true],
      {
        off: ['H: 손동작 켜기', H.textPx, H.color],
        loading: ['웹캠 준비 중…', H.textPx, H.dim],
        on: ['손동작 켜짐 · 손바닥을 1초 펴면 시작', H.textPx, H.accent],
        failed: ['웹캠을 쓸 수 없어 키보드로 진행해', H.textPx, H.dim],
      }[hand],
    ]);
  } else {
    lines([
      [`${result.distance} m`, H.titlePx, H.color, true],
      [result.newBest ? 'NEW BEST!' : `BEST ${score.best()} m`, H.hudPx, result.newBest ? H.accent : H.color, true],
      [hand === 'on' ? 'Space / Enter / 손바닥 1초: 다시 하기' : 'Space / Enter: 다시 하기', H.textPx, H.color],
    ]);
  }
}

function drawHandStatus() { // text just above the mirrored preview (bottom-right <video>)
  if (hand !== 'on' && hand !== 'failed') return;
  ctx.font = `bold ${H.textPx}px ${H.font}`;
  ctx.fillStyle = H.color;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  if (hand === 'failed') { // title already shows it in the menu
    if (mode !== 'title') ctx.fillText('웹캠을 쓸 수 없어 키보드로 진행해', w - H.margin, h - H.margin);
    return;
  }
  const st = handStatus;
  const text = !st || !st.hands ? '손 없음' : `${st.gesture} · ${st.side === 'L' ? '왼' : '오'} · ${st.level}`;
  ctx.fillText(text, w - H.margin, camEl.getBoundingClientRect().top - H.margin);
}

function update(dt) {
  // open palm on the title or the result screen = Space
  const palmOk = mode === 'title' || (mode === 'over' && overSec >= CFG.overFallSec);
  palmSec = palmOk && handStatus?.open ? palmSec + dt : 0;
  if (palmSec >= CFG.handRestartSec) { palmSec = 0; start(); }
  if (mode === 'title') return;
  if (bot && g.elapsed < botSec) shots.push(...bot(g, dt));
  const events = stepGame(g, dt, shots);
  shots = [];
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
    aim: mode === 'play' ? tracker.state(t) : null,
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
