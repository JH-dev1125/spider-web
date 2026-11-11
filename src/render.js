import { CFG } from './config.js';
import { hash01 as hash } from './world.js';
import { aimVector, chargeLength } from './web.js';
import { drawCharacter } from './character.js';

const R = CFG.render;
const C = CFG.colors;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

const focal = (fovDeg, h) => (h * 0.5) / Math.tan(fovDeg * DEG * 0.5);

// The one projection formula. Writes px/py/ps; on near-plane rejection they become NaN,
// so any caller that emits a rejected point produces NaN instead of a stale coordinate.
let px = 0, py = 0, ps = 0;
function projectTo(x, y, z, cam, cx, cy, f) {
  const dz = z - cam.z;
  if (dz <= CFG.camNear) { px = py = ps = NaN; return false; }
  ps = f / dz;
  px = cx + (x - cam.x) * ps;
  py = cy - (y - cam.y) * ps;
  return true;
}

export function project(pt, cam, w, h) {
  if (!projectTo(pt.x, pt.y, pt.z, cam, w * 0.5, h * 0.5, focal(cam.fovDeg, h))) return null;
  return { sx: px, sy: py, scale: ps };
}

export function makeCamera(player, prev, dt) {
  const { pos, vel } = player;
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  const k = clamp01((speed - CFG.baseSpeed) / (CFG.maxSpeed - CFG.baseSpeed));
  const fov = CFG.fovMin + (CFG.fovMax - CFG.fovMin) * k;
  const y = pos.y + CFG.camUp;
  const z = pos.z - CFG.camBack;
  if (!prev) return { x: pos.x, y, z, fovDeg: fov };
  const a = 1 - Math.exp(-CFG.camFollow * dt);
  const b = 1 - Math.exp(-CFG.fovFollow * dt);
  // lead z by v/rate so steady-state distance stays camBack instead of growing with speed
  const tz = z + vel.z / CFG.camFollow;
  return {
    x: prev.x + (pos.x - prev.x) * a,
    y: prev.y + (y - prev.y) * a,
    z: prev.z + (tz - prev.z) * a,
    fovDeg: prev.fovDeg + (fov - prev.fovDeg) * b,
  };
}

// ---- precomputed once at load; per-frame drawing allocates only the camera/view objects ----
const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const mix = (a, b, p) => a.map((v, i) => v + (b[i] - v) * p);
const fogRamp = (near) => Array.from({ length: R.fogSteps }, (_, i) => rgb(mix(near, C.faceFar, i / (R.fogSteps - 1))));
const FACE = fogRamp(C.faceNear);
const LIT = fogRamp(C.windowLit);
const SL_ANG = Float64Array.from({ length: R.speedLineCount }, (_, i) => hash(i) * TAU);
const SL_OFF = Float64Array.from({ length: R.speedLineCount }, (_, i) => hash(i + R.speedLineCount));
const NO_DASH = [];
const LIT_DRAWS = 3; // hash values per skyline window
const sorted = [];
let gradH = -1;
let skyGrad = null;
let groundGrad = null;

// per-frame state so hot loops project without allocating
let W = 0, H = 0, CX = 0, CY = 0, F = 1, CAM = null;
let segPs = 0; // scale at a segment's start (the hand)
const pj = (x, y, z) => projectTo(x, y, z, CAM, CX, CY, F);
function quad(ctx, x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3) {
  pj(x0, y0, z0); ctx.moveTo(px, py);
  pj(x1, y1, z1); ctx.lineTo(px, py);
  pj(x2, y2, z2); ctx.lineTo(px, py);
  pj(x3, y3, z3); ctx.lineTo(px, py);
  ctx.closePath();
}
// world segment clipped to the near plane; returns false if fully behind
function seg(ctx, ax, ay, az, bx, by, bz) {
  const zc = CAM.z + R.clipNear;
  if (az < zc && bz < zc) return false;
  if (az < zc) { const p = (zc - az) / (bz - az); ax += (bx - ax) * p; ay += (by - ay) * p; az = zc; }
  if (bz < zc) { const p = (zc - bz) / (az - bz); bx += (ax - bx) * p; by += (ay - by) * p; bz = zc; }
  pj(ax, ay, az); ctx.moveTo(px, py);
  segPs = ps;
  pj(bx, by, bz); ctx.lineTo(px, py);
  return true;
}

function drawSky(ctx) {
  if (gradH !== H) {
    gradH = H;
    skyGrad = ctx.createLinearGradient(0, 0, 0, CY);
    skyGrad.addColorStop(0, C.skyTop);
    skyGrad.addColorStop(0.5, C.skyMid);
    skyGrad.addColorStop(1, C.skyHorizon);
    groundGrad = ctx.createLinearGradient(0, CY, 0, H);
    groundGrad.addColorStop(0, C.groundFar);
    groundGrad.addColorStop(1, C.ground);
  }
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, CY + 1);
  ctx.fillStyle = groundGrad;
  ctx.fillRect(0, CY, W, H - CY);
}

function drawSkyline(ctx) {
  const layers = R.skyline;
  for (let l = 0; l < layers.length; l++) {
    const L = layers[l];
    const base = Math.floor(CAM.z * L.parallax / L.colW);
    const scroll = CAM.z * L.parallax - base * L.colW;
    ctx.fillStyle = L.color;
    ctx.beginPath();
    for (let side = 0; side < 2; side++) {
      const s = side ? 1 : -1;
      // columns drift outward from the vanishing point as the camera advances
      for (let u = scroll - L.colW, i = -1; u < W * 0.5; u += L.colW, i++) {
        const r = hash(((i - base) * layers.length + l) * 2 + side);
        const hh = H * (L.hMin + (L.hMax - L.hMin) * r);
        const x = s > 0 ? CX + u : CX - u - L.colW;
        ctx.rect(x, CY - hh, L.colW + 1, hh + 1);
      }
    }
    ctx.fill();
  }
  // sparse lit windows on the nearest layer
  const L = layers[layers.length - 1];
  const base = Math.floor(CAM.z * L.parallax / L.colW);
  const scroll = CAM.z * L.parallax - base * L.colW;
  ctx.fillStyle = C.skylineLit;
  ctx.beginPath();
  for (let side = 0; side < 2; side++) {
    const s = side ? 1 : -1;
    for (let u = scroll - L.colW, i = -1; u < W * 0.5; u += L.colW, i++) {
      const seed = ((i - base) * layers.length + layers.length - 1) * 2 + side;
      const hh = H * (L.hMin + (L.hMax - L.hMin) * hash(seed)); // same height as the silhouette pass
      const x0 = s > 0 ? CX + u : CX - u - L.colW;
      for (let k = 0; k < R.skylineLitPerCol; k++) {
        const j = (seed * R.skylineLitPerCol + k) * LIT_DRAWS; // own hash domain: [chance, x, y]
        if (hash(-j) > R.skylineLitChance) continue;
        ctx.rect(x0 + hash(-j - 1) * (L.colW - R.skylineLitPx), CY - hh * hash(-j - 2), R.skylineLitPx, R.skylineLitPx);
      }
    }
  }
  ctx.fill();
}

function drawGround(ctx, t) {
  const hw = CFG.corridorHalfWidth;
  const zn = CAM.z + R.clipNear;
  const zf = CAM.z + CFG.viewDistance;
  ctx.fillStyle = C.street;
  ctx.beginPath();
  quad(ctx, -hw, 0, zn, -hw, 0, zf, hw, 0, zf, hw, 0, zn);
  ctx.fill();

  // street lights on a fixed world grid
  ctx.fillStyle = C.streetLight;
  ctx.beginPath();
  const sp = R.streetLightSpacing;
  for (let z = Math.ceil(zn / sp) * sp; z < zf; z += sp) {
    for (const x of R.streetLightXs) {
      if (!pj(x, 0, z)) continue;
      const s = Math.max(R.streetLightMin, R.streetLightSize * ps);
      ctx.rect(px - s * 0.5, py - s * 0.5, s, s);
    }
  }
  ctx.fill();

  // traffic: right lanes drive away (tail lights), left lanes come at us (head lights)
  const cs = R.carSpacing;
  const lanes = R.carLanes;
  for (let pass = 0; pass < 2; pass++) {
    ctx.fillStyle = pass ? C.carTail : C.carHead;
    ctx.beginPath();
    for (let li = 0; li < lanes.length; li++) {
      const x = lanes[li];
      if ((x > 0) !== (pass === 1)) continue;
      const shift = (x > 0 ? 1 : -1) * t * R.carSpeed;
      for (let n = Math.ceil((zn - shift) / cs); n * cs + shift < zf; n++) {
        if (hash(n * lanes.length + li) < R.carGapChance) continue;
        if (!pj(x, 0, n * cs + shift)) continue;
        const s = Math.max(R.streetLightMin, R.streetLightSize * ps);
        ctx.rect(px - s, py - s * 0.5, s * 0.5, s * 0.5);
        ctx.rect(px + s * 0.5, py - s * 0.5, s * 0.5, s * 0.5);
      }
    }
    ctx.fill();
  }
}

function drawBuilding(ctx, b) {
  const s = b.side === 'L' ? -1 : 1;
  const xF = s * CFG.corridorHalfWidth;
  const xB = xF + s * R.buildingDepth;
  const zA = Math.max(b.z0, CAM.z + R.clipNear);
  const z1 = b.z1;
  if (z1 <= zA) return;
  const h = b.h;
  const mid = (zA + z1) * 0.5 - CAM.z;
  const fog = Math.round(clamp01(mid / CFG.viewDistance) * (R.fogSteps - 1));

  if (b.z0 >= zA) { // end face toward the camera
    ctx.fillStyle = C.endFace;
    ctx.beginPath();
    quad(ctx, xF, 0, b.z0, xF, h, b.z0, xB, h, b.z0, xB, 0, b.z0);
    ctx.fill();
  }
  if (CAM.y > h) {
    ctx.fillStyle = C.roof;
    ctx.beginPath();
    quad(ctx, xF, h, zA, xB, h, zA, xB, h, z1, xF, h, z1);
    ctx.fill();
  }
  ctx.fillStyle = FACE[fog];
  ctx.beginPath();
  quad(ctx, xF, 0, zA, xF, h, zA, xF, h, z1, xF, 0, z1);
  ctx.fill();

  // window bands: capped row count, lit/dark per row from a per-building seed
  const rows = Math.max(1, Math.min(R.windowRowsMax, Math.floor(h / R.floorH)));
  const step = h / rows;
  const glass = step * R.windowFill;
  const bseed = (Math.floor(b.z0) * 2 + (s > 0 ? 1 : 0)) * R.windowRowsMax;
  for (let pass = 0; pass < 2; pass++) {
    ctx.fillStyle = pass ? LIT[fog] : C.windowDark;
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      const lit = hash(bseed + r) < R.windowLitChance; // stateless: both passes agree per row
      if (lit !== (pass === 1)) continue;
      const y0 = r * step + (step - glass) * 0.5;
      quad(ctx, xF, y0, zA, xF, y0 + glass, zA, xF, y0 + glass, z1, xF, y0, z1);
    }
    ctx.fill();
  }
  const cols = Math.min(R.windowColsMax, Math.ceil((z1 - b.z0) / R.windowColSpacing));
  const cw = (z1 - b.z0) / cols;
  ctx.strokeStyle = C.mullion;
  ctx.lineWidth = Math.min(R.mullionMaxPx, Math.max(1, (F / mid) * R.mullionW));
  ctx.beginPath();
  for (let c = 1; c < cols; c++) {
    const z = b.z0 + c * cw;
    if (z <= zA) continue;
    pj(xF, 0, z); ctx.moveTo(px, py);
    pj(xF, h, z); ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function drawBuildings(ctx, buildings) {
  sorted.length = 0;
  for (const b of buildings) sorted.push(b);
  sorted.sort((a, b) => b.z0 - a.z0);
  for (const b of sorted) drawBuilding(ctx, b);
}

function drawLine(ctx, from, to, alpha) {
  ctx.beginPath();
  if (!seg(ctx, from.x, from.y + R.playerHand, from.z, to.x, to.y, to.z)) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = C.web;
  ctx.lineWidth = Math.min(R.webMaxPx, Math.max(R.webMinPx, R.webWidth * segPs));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawAim(ctx, pos, aim) {
  const d = aimVector(aim.side, aim.level);
  const len = chargeLength(aim.heldSec);
  const y = pos.y + R.playerHand;
  ctx.beginPath();
  if (!seg(ctx, pos.x, y, pos.z, pos.x + d.x * len, y + d.y * len, pos.z + d.z * len)) return;
  const ex = px, ey = py;
  ctx.setLineDash(R.aimDash);
  ctx.strokeStyle = C.aim;
  ctx.lineWidth = R.aimWidthPx;
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
  ctx.beginPath();
  ctx.arc(ex, ey, R.aimDotPx, 0, TAU);
  ctx.fillStyle = C.aim;
  ctx.fill();
}

function drawSpeedLines(ctx, speed, t) {
  const start = CFG.baseSpeed * R.speedLineStart;
  if (speed < start) return;
  const k = clamp01((speed - start) / (CFG.baseSpeed * (R.speedLineFull - R.speedLineStart)));
  const n = Math.ceil(R.speedLineCount * Math.max(k, R.speedLineMinFrac));
  const rad = Math.hypot(CX, CY);
  const span = 1 - R.speedLineInner;
  ctx.globalAlpha = Math.max(k, R.speedLineMinFrac);
  ctx.strokeStyle = C.speedLine;
  ctx.lineWidth = R.speedLineWidth;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ph = (t * R.speedLineRate + SL_OFF[i]) % 1; // streaks drift outward like passing scenery
    const r0 = rad * (R.speedLineInner + span * ph);
    const r1 = r0 + rad * R.speedLineLen;
    const cs = Math.cos(SL_ANG[i]), sn = Math.sin(SL_ANG[i]);
    ctx.moveTo(CX + cs * r0, CY + sn * r0);
    ctx.lineTo(CX + cs * r1, CY + sn * r1);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawFrame(ctx, w, h, view) {
  const { player, cam, t } = view;
  W = w; H = h; CX = w * 0.5; CY = h * 0.5; CAM = cam;
  F = focal(cam.fovDeg, h);
  drawSky(ctx);
  ctx.save();
  const sh = view.shake || 0;
  if (sh > 0) ctx.translate(Math.sin(t * R.shakeFreqX) * sh, Math.cos(t * R.shakeFreqY) * sh);
  drawSkyline(ctx);
  drawGround(ctx, t);
  drawBuildings(ctx, view.buildings);
  if (player.anchor) drawLine(ctx, player.pos, player.anchor, 1);
  if (view.missLine) drawLine(ctx, player.pos, view.missLine.to, clamp01(1 - view.missLine.age / CFG.missShowSec));
  if (view.aim) drawAim(ctx, player.pos, view.aim);
  if (pj(player.pos.x, player.pos.y, player.pos.z)) {
    // poses are authored reaching right; mirror about the body so the web hand faces the anchor
    const flip = player.anchor && player.anchor.x < player.pos.x;
    if (flip) { ctx.save(); ctx.translate(px + px, 0); ctx.scale(-1, 1); }
    drawCharacter(ctx, px, py, ps, view.pose, t);
    if (flip) ctx.restore();
  }
  ctx.restore();
  const v = player.vel;
  drawSpeedLines(ctx, Math.hypot(v.x, v.y, v.z), t);
}
