import { CFG } from './config.js';
import { createGame, stepGame, createBot, startGame } from './game.js';
import { placeHero } from './player.js';
import { createChargeTracker } from './input-core.js';
import { attachKeyboard } from './keyboard.js';
import { startHand } from './hand.js';
import { handStatusText } from './hand-classify.js';
import { createScore } from './score.js';

const canvas = document.getElementById('game'); // 2D HUD overlay; the 3D scene draws on #gl below it
const ctx = canvas.getContext('2d');
let w = 0, h = 0;
let renderer = null; // three.js loads from a CDN: if it fails, say so instead of a blank screen
import('./render.js')
  .then((m) => { renderer = m.createRenderer(document.getElementById('gl')); resize(); frame(); })
  .catch((err) => {
    console.error(err);
    renderer = null;
    const p = document.body.appendChild(document.createElement('p'));
    p.textContent = `3D 렌더러를 불러오지 못했습니다 (${err.message}). 네트워크를 확인하고 새로고침하세요.`;
    p.style.cssText = 'position:fixed;left:0;right:0;bottom:40px;margin:0;text-align:center;color:#fff;font:16px system-ui';
    frame();
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
// ?t=<sec> fast-forwards (see the bottom); ?autozip makes the bot zip up its ropes; ?autoturn[=L|R|alt] makes it
// turn at every intersection (alt: right, then left, ...); ?seed=<n> fixes the city.
const q = new URLSearchParams(location.search);
const autoplay = q.has('autoplay');
const botSec = Number(q.get('autoplay')) || Infinity;

let storage;
try { storage = window.localStorage; } catch { /* blocked: score stays in memory */ }
const score = createScore(storage);
const tracker = createChargeTracker();
const now = () => performance.now() / 1000;

let mode = 'title'; // 'title' | 'play' | 'over'
const seedOf = () => Number(q.get('seed')) || Date.now(); // ?seed=<n>: a fixed city (screenshots)
const newGame = () => createGame(seedOf(), { start: 'roof' }); // the hero idles on the start roof's edge
let g = newGame();
let actions = []; // input queue for stepGame: {type:'press'|'release'|'zip', ...}
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

// From the title: the same game - the hero dives head first off the start roof. From the result screen: a new game.
function start() {
  if (mode === 'over') g = newGame();
  startGame(g);
  actions = [];
  tracker.cancel(); // a key held through death must not release anything on the first frame
  bot = autoplay ? createBot({ zip: q.has('autozip'), turn: q.has('autoturn') ? q.get('autoturn') || 'alt' : null,
    freeSec: Number(q.get('free')) || undefined }) : null; // ?free=<sec>: fly that long between ropes (the flight chain, big air)
  mode = 'play';
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  e.preventDefault();
  if (e.repeat) return;
  if (mode === 'title' || (mode === 'over' && landed() && overSec >= overGate)) start();
});

// The result appears once the hero landing has settled (the pose holds on under it); restart only after that.
const landed = () => (g.phys.landing?.sec ?? 0) >= CFG.moves.landingSettleSec;
const overGate = CFG.overInputDelaySec;
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
    ctx.fillText(`${mode === 'over' ? result.distance : Math.max(0, Math.floor(g.distance))} m`, w * 0.5, H.margin);
    ctx.font = `${H.textPx}px ${H.font}`;
    ctx.textAlign = 'right';
    ctx.fillText(`BEST ${score.best()} m`, w - H.margin, H.margin);
  }
  const showResult = mode === 'over' && landed();
  if (mode === 'play' || (mode === 'over' && !showResult)) return;
  ctx.fillStyle = H.backdrop;
  ctx.fillRect(0, 0, w, h);
  if (mode === 'title') {
    lines([
      ['WEB RUNNER', H.titlePx, H.color, true],
      ['왼쪽 Q · A · Z   /   오른쪽 E · D · C   (위 · 가운데 · 아래)', H.textPx, H.color],
      ['W: 정면 위로 — 길 위의 크레인 · 구름다리에 줄', H.textPx, H.color],
      ['누르면 즉시 거미줄 → 누르고 있는 동안 스윙 → 떼면 날아감', H.textPx, H.color],
      ['Space / 손 당기기: 줄을 놓으며 앞으로 발사 (새총)', H.textPx, H.color],
      coarse ? ['PC(키보드/웹캠)에서 열어주세요', H.hudPx, H.accent, true] : ['Space: 옥상에서 뒤로 공중제비하며 시작', H.hudPx, H.accent, true],
      ['바닥에 닿으면 끝 · 너무 오래 잡고 있으면 뒤로 되돌아가요', H.textPx, H.color],
      hand === 'on' && ['검지·새끼 펴면 발사, 유지하면 스윙, 풀면 날아감 (미리보기 속 손 위치 = 방향, 가운데 칸 = W)', H.textPx, H.color],
      hand === 'on' && ['발사 자세로 손을 몸 쪽으로 확 당기면 새총 발사', H.textPx, H.color],
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
  const r = camEl.getBoundingClientRect();
  ctx.fillText(handStatusText(st), w - H.margin, r.top - H.margin);
  // zone guides over the preview: left / middle (W) / right thirds and the hi/mid/lo cuts the game actually uses
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const k of CFG.handSideCuts) { ctx.moveTo(r.left + r.width * k, r.top); ctx.lineTo(r.left + r.width * k, r.bottom); }
  for (const k of CFG.handLevelCuts) { ctx.moveTo(r.left, r.top + r.height * k); ctx.lineTo(r.right, r.top + r.height * k); }
  ctx.stroke();
}

function update(dt) {
  // open palm on the title or the result screen = Space
  const palmOk = mode === 'title' || (mode === 'over' && landed());
  palmSec = palmOk && handStatus?.open ? palmSec + dt : 0;
  if (palmSec >= CFG.handRestartSec) { palmSec = 0; start(); }
  if (mode === 'title') { stepGame(g, dt, []); return; } // he idles on the roof under the title
  if (bot && g.elapsed < botSec) actions.push(...bot(g, dt));
  else if (bot) { actions.push({ type: 'release' }); bot = null; } // ?autoplay=<sec>: then let go and fall (the landing)
  const events = stepGame(g, dt, actions);
  actions = [];
  if (mode === 'play' && events.includes('dead')) {
    mode = 'over';
    overSec = 0;
    tracker.cancel();
    const distance = Math.max(0, Math.floor(g.distance)); // metres along the streets, turns included
    result = { distance, newBest: score.submit(distance) };
  } else if (mode === 'over') overSec += dt;
}

let last = now();
function frame() {
  const t = now();
  const dt = Math.min(CFG.maxDt, t - last); // also keeps a tab switch from becoming one huge step
  last = t;
  if (!q.has('t')) update(dt);
  renderer?.render({
    player: g.player,
    structures: g.world.structures,
    web: g.web,
    missLine: g.missLine,
    pose: g.pose,
    t,
    shake: g.shake,
    street: g.street,
    distance: g.distance,
    seed: g.world.seed,
    landing: g.phys.landing, // { sec, at } after street contact: dust and the camera dip
    title: mode === 'title',
  }, dt);
  ctx.clearRect(0, 0, w, h);
  if (!q.has('nohud')) { drawHud(); drawHandStatus(); } // ?nohud: the bare scene (screenshots)
  requestAnimationFrame(frame);
}
// ?stage=climb|roof (screenshots): start beside / on top of a street-side tower near the start, no bot: thrown up
// its facade (a vertical wall run, the vault and perch) or standing on its roof (the run, then the idle).
const stage = q.get('stage');
if (stage) {
  start(); bot = null;
  const W = CFG.corridorHalfWidth, s = g.world.structures.find((b) => b.kind === 'tower' && Math.abs(b.min.x - W) < .5
    && b.min.z < 140 && b.max.z > 40 && b.max.y > 60);
  if (s) {
    const z = Math.min(s.max.z - 10, Math.max(s.min.z + 10, 80));
    g.phys.startPhase = g.player.phase = 'play';
    if (stage === 'climb') placeHero(g.phys, g.player, { x: W - 2, y: s.max.y - 22, z }, { x: 6, y: 12, z: 1 });
    else placeHero(g.phys, g.player, { x: W + .8, y: s.max.y + CFG.heroRadius, z }, { x: 0, y: 0, z: 0 }); // (roofs: the street margin)
  }
  for (let t = 0; t < (Number(q.get('t')) || 0); t += CFG.maxDt) update(CFG.maxDt);
} else if (autoplay) {
  start();
  // ?t=<sec> fast-forwards the autoplay in maxDt steps (headless screenshots barely advance rAF)
  for (let s = 0; s < (Number(q.get('t')) || 0); s += CFG.maxDt) update(CFG.maxDt);
}
