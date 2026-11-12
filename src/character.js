import { CFG } from './config.js';

// Swap-out point: drawCharacter (and characterHand for the web origin). Back view ("behind the back"),
// red/blue masked web-slinger. Poses are authored reaching right; render.js mirrors for the left.
const K = CFG.character;
const B = K.body;
const P = K.palette;
const RED = CFG.colors.suitRed;
const LENS = CFG.colors.lens;
const TAU = Math.PI * 2;

// pose = flat numbers so poses blend with one loop: 4 limbs x [a1, a2, len1, len2], lean, look, spin, flail
const LIMBS = ['armL', 'armR', 'legL', 'legR'];
const LEAN = 16, LOOK = 17, SPIN = 18, FLAIL = 19;
const POSE = {};
for (const [name, p] of Object.entries(K.poses)) {
  POSE[name] = Float64Array.from([...LIMBS.flatMap((k) => p[k]), p.lean, p.look, p.spin, p.flail]);
}
const cur = new Float64Array(POSE.glide);
let lastT = NaN;
let rot = 0; // roll spin angle

// limb joints in body units: per limb [rootX, rootY, elbowX, elbowY, endX, endY]
const J = new Float64Array(24);
const ROOT = [[-B.shoulderX, B.shoulderY], [B.shoulderX, B.shoulderY], [-B.hipX, B.hipY], [B.hipX, B.hipY]];

// precomputed web pattern on the back: radials from the emblem, sagging rings between them
const WEB_N = 14;
const WEB_C = [0, -0.14];
const WEB_RINGS = [0.045, 0.09, 0.14, 0.195, 0.255];
const WEB_COS = Float64Array.from({ length: WEB_N + 1 }, (_, i) => Math.cos((i / WEB_N) * TAU + 0.11));
const WEB_SIN = Float64Array.from({ length: WEB_N + 1 }, (_, i) => Math.sin((i / WEB_N) * TAU + 0.11));
const MID_COS = Float64Array.from({ length: WEB_N }, (_, i) => Math.cos(((i + 0.5) / WEB_N) * TAU + 0.11));
const MID_SIN = Float64Array.from({ length: WEB_N }, (_, i) => Math.sin(((i + 0.5) / WEB_N) * TAU + 0.11));
// spider emblem legs: [x0, y0, kneeX, kneeY, footX, footY] for the right side; left is mirrored
const SPIDER_LEGS = [
  [0.01, -0.172, 0.04, -0.2, 0.05, -0.23],
  [0.012, -0.164, 0.045, -0.178, 0.062, -0.19],
  [0.012, -0.156, 0.045, -0.146, 0.062, -0.13],
  [0.01, -0.15, 0.038, -0.125, 0.048, -0.095],
];

function update(pose, t) {
  const tgt = POSE[pose] || POSE.glide;
  const dt = t - lastT;
  lastT = t;
  if (!(dt >= 0 && dt < 0.5)) { cur.set(tgt); rot = 0; return; } // first frame or a time jump: snap
  if (dt === 0) return; // second call in the same frame
  const a = 1 - Math.exp(-K.blendRate * dt);
  for (let i = 0; i < cur.length; i++) cur[i] += (tgt[i] - cur[i]) * a;
  if (tgt[SPIN]) rot = (rot + K.rollSpeed * dt) % TAU;
  else rot += ((rot > Math.PI ? TAU : 0) - rot) * a; // settle upright the short way
}

function joints(t) {
  const fl = cur[FLAIL] * K.flailAmp;
  for (let i = 0; i < 4; i++) {
    const o = i * 4, sd = i % 2 ? 1 : -1, segs = i < 2 ? B.arm : B.leg;
    const a1 = cur[o] + fl * Math.sin(t * K.flailSpeed + i);
    const a2 = a1 + cur[o + 1] + fl * Math.sin(t * K.flailSpeed * 1.3 + i + 1);
    const j = i * 6, x = ROOT[i][0], y = ROOT[i][1];
    const ex = x + sd * Math.sin(a1) * segs[0] * cur[o + 2], ey = y + Math.cos(a1) * segs[0] * cur[o + 2];
    J[j] = x; J[j + 1] = y; J[j + 2] = ex; J[j + 3] = ey;
    J[j + 4] = ex + sd * Math.sin(a2) * segs[1] * cur[o + 3];
    J[j + 5] = ey + Math.cos(a2) * segs[1] * cur[o + 3];
  }
}

const unit = (scale) => Math.min(K.maxPx, Math.max(K.minPx, K.height * scale * K.drawScale));

// Screen offset (px, unmirrored) of the web hand from the body centre, for the same pose/t as drawCharacter.
export function characterHand(pose, t, scale, out) {
  update(pose, t);
  joints(t);
  const u = unit(scale), a = cur[LEAN] + rot, c = Math.cos(a), s = Math.sin(a);
  const x = J[10], y = J[11]; // armR end
  out.x = (x * c - y * s) * u;
  out.y = (x * s + y * c) * u;
  return out;
}

// ---- drawing: mode 0 = soft halo, 1 = dark outline, 2 = colour ----
let M = 2, EX = 0;
function style(ctx, color) {
  const c = M === 0 ? P.halo : M === 1 ? P.outline : color;
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
}
function bone(ctx, x0, y0, x1, y1, w, color) {
  style(ctx, color);
  ctx.lineWidth = w + EX;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}
function blob(ctx, x, y, rx, ry, color) {
  style(ctx, color);
  ctx.beginPath(); ctx.ellipse(x, y, rx + EX * 0.5, ry + EX * 0.5, 0, 0, TAU); ctx.fill();
}
function torsoPath(ctx) {
  const cw = B.chestW, ww = B.waistW, top = B.shoulderY - 0.03, px = B.hipX + 0.04, py = B.hipY + 0.035;
  ctx.beginPath();
  ctx.moveTo(-cw, top + 0.035);
  ctx.quadraticCurveTo(-cw, top, -0.05, top - 0.005);
  ctx.lineTo(0.05, top - 0.005);
  ctx.quadraticCurveTo(cw, top, cw, top + 0.035);
  ctx.quadraticCurveTo(cw * 0.98, -0.11, ww, B.waistY);
  ctx.lineTo(px, py);
  ctx.quadraticCurveTo(0, py + 0.03, -px, py);
  ctx.lineTo(-ww, B.waistY);
  ctx.quadraticCurveTo(-cw * 0.98, -0.11, -cw, top + 0.035);
  ctx.closePath();
}
function limbs(ctx, from, to) {
  for (let i = from; i < to; i++) {
    const j = i * 6, arm = i < 2, W = arm ? B.armW : B.legW;
    bone(ctx, J[j], J[j + 1], J[j + 2], J[j + 3], W[0], P.blue);
    bone(ctx, J[j + 2], J[j + 3], J[j + 4], J[j + 5], W[1], RED);
    const r = arm ? B.handR : B.footR;
    blob(ctx, J[j + 4], J[j + 5], r, arm ? r : r * 1.15, RED);
  }
}
function core(ctx) { // legs, torso, neck, head
  limbs(ctx, 2, 4);
  style(ctx, RED);
  torsoPath(ctx);
  ctx.fill();
  if (EX) { ctx.lineWidth = EX; ctx.stroke(); }
  bone(ctx, 0, B.shoulderY - 0.02, 0, B.headY + B.headR * 0.6, 0.05, RED);
  blob(ctx, 0, B.headY, B.headR * 0.92, B.headR * 1.06, RED);
}

function backDetails(ctx) {
  ctx.save();
  torsoPath(ctx);
  ctx.clip();
  // blue side panels and a shaded flank away from the sunset
  ctx.fillStyle = P.blue;
  ctx.beginPath();
  for (const s of [-1, 1]) {
    ctx.moveTo(s * (B.chestW + 0.01), B.shoulderY + 0.01);
    ctx.lineTo(s * B.chestW * 0.62, B.shoulderY + 0.05);
    ctx.lineTo(s * B.waistW * 0.55, B.waistY + 0.06);
    ctx.lineTo(s * (B.waistW + 0.05), B.waistY + 0.06);
  }
  ctx.fill();
  ctx.fillStyle = P.shade;
  ctx.fillRect(-0.3, -0.4, 0.3, 0.5);
  // web lines
  ctx.strokeStyle = P.web;
  ctx.lineWidth = B.webW;
  ctx.beginPath();
  const cx = WEB_C[0], cy = WEB_C[1], rMax = WEB_RINGS[WEB_RINGS.length - 1] * 1.6;
  for (let i = 0; i < WEB_N; i++) { ctx.moveTo(cx, cy); ctx.lineTo(cx + WEB_COS[i] * rMax, cy + WEB_SIN[i] * rMax); }
  for (const r of WEB_RINGS) {
    for (let i = 0; i < WEB_N; i++) {
      ctx.moveTo(cx + WEB_COS[i] * r, cy + WEB_SIN[i] * r);
      ctx.quadraticCurveTo(cx + MID_COS[i] * r * 0.84, cy + MID_SIN[i] * r * 0.84, cx + WEB_COS[i + 1] * r, cy + WEB_SIN[i + 1] * r);
    }
  }
  ctx.stroke();
  // spider emblem
  ctx.strokeStyle = P.emblem;
  ctx.lineWidth = 0.009;
  ctx.beginPath();
  for (const s of [-1, 1]) {
    for (const l of SPIDER_LEGS) {
      ctx.moveTo(s * l[0], l[1]); ctx.lineTo(s * l[2], l[3]); ctx.lineTo(s * l[4], l[5]);
    }
  }
  ctx.stroke();
  ctx.fillStyle = P.emblem;
  ctx.beginPath();
  ctx.ellipse(0, -0.178, 0.014, 0.016, 0, 0, TAU);
  ctx.moveTo(0.02, -0.135);
  ctx.ellipse(0, -0.135, 0.02, 0.033, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function headDetails(ctx) {
  const hy = B.headY, hr = B.headR;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, hy, hr * 0.92, hr * 1.06, 0, 0, TAU);
  ctx.clip();
  ctx.strokeStyle = P.web;
  ctx.lineWidth = B.webW;
  ctx.beginPath();
  for (let i = 0; i < WEB_N; i += 2) { ctx.moveTo(0, hy - hr * 0.1); ctx.lineTo(WEB_COS[i] * hr * 1.3, hy - hr * 0.1 + WEB_SIN[i] * hr * 1.3); }
  for (const r of [0.35, 0.7]) {
    ctx.moveTo(hr * r, hy - hr * 0.1);
    ctx.ellipse(0, hy - hr * 0.1, hr * r, hr * r * 1.1, 0, 0, TAU);
  }
  ctx.stroke();
  ctx.restore();
  // big lenses peek past the mask outline; the side he looks toward shows more
  const look = cur[LOOK];
  for (const s of [-1, 1]) {
    const v = Math.max(0, s * look);
    const x = s * hr * (0.98 - 0.35 * v), y = hy - hr * 0.08;
    const rx = hr * (0.1 + B.lensW * v), ry = hr * B.lensH * (0.75 + 0.25 * v), tilt = s * 0.45;
    ctx.fillStyle = P.lensRim;
    ctx.beginPath(); ctx.ellipse(x, y, rx + 0.009, ry + 0.009, tilt, 0, TAU); ctx.fill();
    ctx.fillStyle = LENS;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, tilt, 0, TAU); ctx.fill();
  }
}

export function drawCharacter(ctx, sx, sy, scale, pose, t) {
  update(pose, t);
  joints(t);
  const u = unit(scale);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(u, u);
  ctx.rotate(cur[LEAN] + rot);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  M = 0; EX = B.halo * 2; core(ctx); limbs(ctx, 0, 2);
  M = 1; EX = B.outline * 2; core(ctx);
  M = 2; EX = 0; core(ctx);
  backDetails(ctx);
  headDetails(ctx);
  // arms last, each with its own outline so they separate from the back
  M = 1; EX = B.outline * 2; limbs(ctx, 0, 2);
  M = 2; EX = 0; limbs(ctx, 0, 2);
  ctx.restore();
}
