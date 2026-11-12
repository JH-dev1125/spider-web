import { CFG } from './config.js';
import { hash01 as hash } from './world.js';
import { aimVector, chargeLength } from './web.js';
import { drawCharacter, characterHand } from './character.js';

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
const hexRgb = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const TINTS = R.facadeTints.map(fogRamp);
const LIT = fogRamp(C.windowLit);
const GLASS = { dark: fogRamp(hexRgb(C.windowDark)), curtain: fogRamp(R.curtainGlass) };
const CORNICE = fogRamp(hexRgb(R.corniceColor));
const STYLES = R.windowStyles;
const HAND = { x: 0, y: 0 };
const SL_ANG = Float64Array.from({ length: R.speedLineCount }, (_, i) => hash(i) * TAU);
const SL_OFF = Float64Array.from({ length: R.speedLineCount }, (_, i) => hash(i + R.speedLineCount));
const NO_DASH = [];
const LIT_DRAWS = 3; // hash values per skyline window
const sorted = [];
let gradH = -1, gradW = -1;
let skyGrad = null;
let groundGrad = null;
let sunGrad = null;
let hazeGrad = null;
let vignette = null;
let vigW = 0;

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
  if (gradH !== H || gradW !== W) {
    gradH = H; gradW = W;
    skyGrad = ctx.createLinearGradient(0, 0, 0, CY);
    skyGrad.addColorStop(0, C.skyTop);
    skyGrad.addColorStop(0.5, C.skyMid);
    skyGrad.addColorStop(1, C.skyHorizon);
    groundGrad = ctx.createLinearGradient(0, CY, 0, H);
    groundGrad.addColorStop(0, C.groundFar);
    groundGrad.addColorStop(1, C.ground);
    const sx = CX + W * R.sunX, sr = H * 0.6;
    sunGrad = ctx.createRadialGradient(sx, CY, 0, sx, CY, sr);
    sunGrad.addColorStop(0, 'rgba(255,236,190,0.95)');
    sunGrad.addColorStop(0.06, R.sunGlow);
    sunGrad.addColorStop(1, 'rgba(255,190,120,0)');
    hazeGrad = ctx.createLinearGradient(0, CY - H * 0.2, 0, CY + H * 0.06);
    hazeGrad.addColorStop(0, 'rgba(255,170,120,0)');
    hazeGrad.addColorStop(0.75, R.hazeGlow);
    hazeGrad.addColorStop(1, 'rgba(255,170,120,0)');
    const d = Math.hypot(CX, CY);
    const r0 = d * 0.7;
    vignette = ctx.createRadialGradient(CX, CY, r0, CX, CY, d);
    vigW = r0 > CY ? Math.ceil(CX - Math.sqrt(r0 * r0 - CY * CY)) : CX;
    vignette.addColorStop(0, 'rgba(4,4,18,0)');
    vignette.addColorStop(1, R.vignette);
  }
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, CY + 1);
  ctx.fillStyle = sunGrad;
  ctx.fillRect(CX + W * R.sunX - H * 0.6, CY - H * 0.6, H * 1.2, H * 0.6 + 1);
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

const fogAt = (d) => Math.round(clamp01(d / CFG.viewDistance) * (R.fogSteps - 1));

// Near LOD: one quad per window, only for columns on screen and rows on screen at each column.
function drawGrid(ctx, b, xF, zFrom, zTo, st, seed) {
  const cw = R.windowColSpacing, fh = R.floorH, zc = CAM.z + R.clipNear;
  const floors = Math.floor((b.h - R.corniceH) / fh);
  const c0 = Math.max(0, Math.floor((zFrom - b.z0) / cw));
  const c1 = Math.min(Math.floor((b.z1 - b.z0) / cw), Math.ceil((zTo - b.z0) / cw), c0 + R.gridColsMax);
  const gw = st.gw * cw, gh = st.gh * fh, ox = (cw - gw) * 0.5, oy = (fh - gh) * 0.5;
  const fog = fogAt((zFrom + zTo) * 0.5 - CAM.z);
  for (let pass = 0; pass < 2; pass++) {
    ctx.fillStyle = pass ? LIT[fog] : GLASS[st.glass][fog];
    ctx.beginPath();
    for (let c = c0; c < c1; c++) {
      let za = b.z0 + c * cw + ox;
      const zb = za + gw;
      if (zb <= zc) continue;
      if (za < zc) za = zc;
      const k = (zb - CAM.z) / F; // metres per px at the column's far edge, where most rows show
      let r0 = Math.max(0, Math.floor((CAM.y - (H - CY) * k) / fh) - 1);
      let r1 = Math.min(floors, Math.ceil((CAM.y + CY * k) / fh) + 1);
      if (r1 - r0 > R.gridRowsMax) {
        r0 = Math.max(r0, Math.floor(CAM.y / fh) - (R.gridRowsMax >> 1));
        r1 = Math.min(r1, r0 + R.gridRowsMax);
      }
      for (let r = r0; r < r1; r++) {
        if ((hash((seed * 512 + c) * 128 + r) < st.lit) !== (pass === 1)) continue;
        const y0 = r * fh + oy;
        quad(ctx, xF, y0, za, xF, y0 + gh, za, xF, y0 + gh, zb, xF, y0, zb);
      }
    }
    ctx.fill();
  }
}

// Mid LOD: one band per floor across the span, cut into columns by facade-coloured piers.
function drawStripes(ctx, b, xF, zA, zB, st, seed, face) {
  const cw = R.windowColSpacing, fh = R.floorH;
  const floors = Math.floor((b.h - R.corniceH) / fh);
  const gh = st.gh * fh, oy = (fh - gh) * 0.5;
  const mid = (zA + zB) * 0.5 - CAM.z;
  const fog = fogAt(mid);
  for (let pass = 0; pass < 2; pass++) {
    ctx.fillStyle = pass ? LIT[fog] : GLASS[st.glass][fog];
    ctx.beginPath();
    for (let r = 0; r < floors; r++) {
      if ((hash((seed * 512 + 511) * 128 + r) < st.lit) !== (pass === 1)) continue;
      const y0 = r * fh + oy;
      quad(ctx, xF, y0, zA, xF, y0 + gh, zA, xF, y0 + gh, zB, xF, y0, zB);
    }
    ctx.fill();
  }
  ctx.strokeStyle = face[fog];
  ctx.lineWidth = Math.min(R.mullionMaxPx, Math.max(1, (F / mid) * (1 - st.gw) * cw));
  ctx.beginPath();
  const top = floors * fh;
  for (let z = b.z0 + Math.ceil((zA - b.z0) / cw) * cw, n = 0; z < zB && n < R.gridColsMax * 2; z += cw, n++) {
    pj(xF, 0, z); ctx.moveTo(px, py);
    pj(xF, top, z); ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function drawRoofItems(ctx, b, s, xF, seed) {
  const h = b.h, len = b.z1 - b.z0, zc = CAM.z + R.clipNear;
  if (hash(seed * 8 + 3) < R.tankChance) { // water tank on legs with a conical lid
    const z = b.z0 + len * (0.2 + 0.5 * hash(seed * 8 + 4)) - 1.6;
    const x = xF + s * R.buildingDepth * (0.3 + 0.4 * hash(seed * 8 + 5));
    if (z > zc) {
      ctx.strokeStyle = R.tankColor;
      ctx.lineWidth = Math.max(1, (0.3 * F) / (z - CAM.z));
      ctx.beginPath();
      pj(x - 1.2, h, z); ctx.moveTo(px, py); pj(x - 1.2, h + 2, z); ctx.lineTo(px, py);
      pj(x + 1.2, h, z); ctx.moveTo(px, py); pj(x + 1.2, h + 2, z); ctx.lineTo(px, py);
      ctx.stroke();
      ctx.fillStyle = R.tankColor;
      ctx.beginPath();
      quad(ctx, x - 1.6, h + 2, z, x - 1.6, h + 6, z, x + 1.6, h + 6, z, x + 1.6, h + 2, z);
      ctx.fill();
      ctx.fillStyle = R.tankTop;
      ctx.beginPath();
      pj(x - 1.9, h + 6, z); ctx.moveTo(px, py);
      pj(x, h + 7.6, z); ctx.lineTo(px, py);
      pj(x + 1.9, h + 6, z); ctx.lineTo(px, py);
      ctx.fill();
    }
  }
  if (hash(seed * 8 + 6) < R.antennaChance) {
    const z = b.z0 + len * (0.55 + 0.35 * hash(seed * 8 + 7));
    const x = xF + s * 2.5;
    if (z > zc) {
      pj(x, h + R.antennaH, z);
      const tx = px, ty = py, sc = ps;
      ctx.strokeStyle = R.tankColor;
      ctx.lineWidth = Math.max(1, 0.25 * sc);
      ctx.beginPath();
      pj(x, h, z); ctx.moveTo(px, py); ctx.lineTo(tx, ty);
      ctx.stroke();
      const d = Math.max(2, 0.6 * sc);
      ctx.fillStyle = R.antennaLight;
      ctx.fillRect(tx - d * 0.5, ty - d * 0.5, d, d);
    }
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
  const fog = fogAt((zA + z1) * 0.5 - CAM.z);
  const seed = Math.floor(b.z0) * 2 + (s > 0 ? 1 : 0);
  const face = TINTS[(hash(seed * 8 + 1) * TINTS.length) | 0];
  const st = STYLES[(hash(seed * 8 + 2) * STYLES.length) | 0];
  const detail = zA - CAM.z < R.stripeDist; // beyond this: flat colour + fog only
  const below = CAM.y < h; // roof items hide behind the faces from below, stand in front of them from above
  if (detail && below) drawRoofItems(ctx, b, s, xF, seed);

  if (b.z0 >= zA) { // end face toward the camera
    ctx.fillStyle = C.endFace;
    ctx.beginPath();
    quad(ctx, xF, 0, b.z0, xF, h, b.z0, xB, h, b.z0, xB, 0, b.z0);
    ctx.fill();
  }
  if (!below) {
    ctx.fillStyle = C.roof;
    ctx.beginPath();
    quad(ctx, xF, h, zA, xB, h, zA, xB, h, z1, xF, h, z1);
    ctx.fill();
  }
  ctx.fillStyle = face[fog];
  ctx.beginPath();
  quad(ctx, xF, 0, zA, xF, h, zA, xF, h, z1, xF, 0, z1);
  ctx.fill();

  if (detail) {
    // the face leaves the screen edge nearer than zVis, so its windows there are never seen
    const zVis = CAM.z + (Math.abs(xF - CAM.x) * F) / CX - R.windowColSpacing;
    const gA = Math.max(zA, zVis), gB = Math.min(z1, CAM.z + R.gridDist);
    if (gB > gA) drawGrid(ctx, b, xF, gA, gB, st, seed);
    const sA = Math.max(zA, CAM.z + R.gridDist), sB = Math.min(z1, CAM.z + R.stripeDist);
    if (sB > sA) drawStripes(ctx, b, xF, sA, sB, st, seed, face);
  }
  // cornice ledge along the top
  ctx.fillStyle = CORNICE[fog];
  ctx.beginPath();
  quad(ctx, xF, h - R.corniceH, zA, xF, h, zA, xF, h, z1, xF, h - R.corniceH, z1);
  ctx.fill();
  if (detail && !below) drawRoofItems(ctx, b, s, xF, seed);
}

function drawBuildings(ctx, buildings) {
  sorted.length = 0;
  for (const b of buildings) sorted.push(b);
  sorted.sort((a, b) => b.z0 - a.z0);
  for (const b of sorted) drawBuilding(ctx, b);
}

// web from the drawn hand (HX, HY, HZ) to a world point
let HX = 0, HY = 0, HZ = 0;
function drawLine(ctx, to, alpha) {
  ctx.beginPath();
  if (!seg(ctx, HX, HY, HZ, to.x, to.y, to.z)) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = C.web;
  ctx.lineWidth = Math.min(R.webMaxPx, Math.max(R.webMinPx, R.webWidth * segPs));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawAim(ctx, pos, aim) {
  const d = aimVector(aim.side, aim.level);
  const len = chargeLength(aim.heldSec);
  const y = pos.y + R.playerHand; // the cast itself starts here (game.js); the dash starts at the drawn hand
  ctx.beginPath();
  if (!seg(ctx, HX, HY, HZ, pos.x + d.x * len, y + d.y * len, pos.z + d.z * len)) return;
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
  ctx.fillStyle = hazeGrad; // warm horizon haze over the far skyline
  ctx.fillRect(-W, CY - H * 0.2, W * 3, H * 0.26);
  drawGround(ctx, t);
  drawBuildings(ctx, view.buildings);
  const pos = player.pos;
  // poses are authored reaching right; mirror about the body so the web hand faces the web
  const to = player.anchor || view.missLine?.to;
  const flip = to ? to.x < pos.x : view.aim?.side === 'L';
  const vis = pj(pos.x, pos.y, pos.z);
  const sx = px, sy = py, s0 = ps;
  HX = pos.x; HY = pos.y + R.playerHand; HZ = pos.z;
  if (vis) {
    characterHand(view.pose, t, s0, HAND);
    HX = pos.x + (flip ? -HAND.x : HAND.x) / s0;
    HY = pos.y - HAND.y / s0;
  }
  if (player.anchor) drawLine(ctx, player.anchor, 1);
  if (view.missLine) drawLine(ctx, view.missLine.to, clamp01(1 - view.missLine.age / CFG.missShowSec));
  if (view.aim) drawAim(ctx, pos, view.aim);
  if (vis) {
    if (flip) { ctx.save(); ctx.translate(sx + sx, 0); ctx.scale(-1, 1); }
    drawCharacter(ctx, sx, sy, s0, view.pose, t);
    if (flip) ctx.restore();
  }
  ctx.restore();
  const v = player.vel;
  drawSpeedLines(ctx, Math.hypot(v.x, v.y, v.z), t);
  ctx.fillStyle = vignette; // nothing to darken between the side bands
  ctx.fillRect(0, 0, vigW, H);
  ctx.fillRect(W - vigW, 0, vigW, H);
}
