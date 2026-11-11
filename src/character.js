import { CFG } from './config.js';

// Swap-out point: only drawCharacter is public. Back view ("behind the back"), red/black masked runner.
const K = CFG.character;
const B = K.body;
const C = CFG.colors;

// one limb: upper + lower segment from joint (jx, jy); sd = -1 left, +1 right
function limb(ctx, jx, jy, sd, ang, segs, scale, upperColor, lowerColor, endColor) {
  const a1 = ang[0];
  const a2 = a1 + ang[1];
  const ex = jx + sd * Math.sin(a1) * segs[0] * scale;
  const ey = jy + Math.cos(a1) * segs[0] * scale;
  const hx = ex + sd * Math.sin(a2) * segs[1] * scale;
  const hy = ey + Math.cos(a2) * segs[1] * scale;
  ctx.strokeStyle = upperColor;
  ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.strokeStyle = lowerColor;
  ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke();
  ctx.fillStyle = endColor;
  ctx.beginPath(); ctx.arc(hx, hy, K.limbW * 0.5, 0, Math.PI * 2); ctx.fill();
}

export function drawCharacter(ctx, sx, sy, scale, pose, t) {
  const P = K.poses[pose] || K.poses.glide;
  const u = Math.max(K.minPx, K.height * scale);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(u, u);
  if (P.spin) ctx.rotate(t * K.rollSpeed);
  ctx.lineCap = 'round';
  ctx.lineWidth = K.limbW;

  const fl = P.flail ? K.flailAmp : 0;
  const wob = (i) => fl * Math.sin(t * K.flailSpeed + i);
  const ang = (a, i) => (fl ? [a[0] + wob(i), a[1] + wob(i + 1)] : a);
  const s = P.limbScale;

  limb(ctx, -B.hipX, B.hipY, -1, ang(P.legL, 0), B.leg, s, C.suitRed, C.suitBlack, C.suitBlack);
  limb(ctx, B.hipX, B.hipY, 1, ang(P.legR, 2), B.leg, s, C.suitRed, C.suitBlack, C.suitBlack);
  limb(ctx, -B.shoulderX, B.shoulderY, -1, ang(P.armL, 1), B.arm, s, C.suitRed, C.suitRed, C.suitBlack);
  limb(ctx, B.shoulderX, B.shoulderY, 1, ang(P.armR, 3), B.arm, s, C.suitRed, C.suitRed, C.suitBlack);

  // torso: tapered red back with black side panels and spine stripe
  const tw = B.torsoW * 0.5, ww = B.waistW * 0.5;
  ctx.fillStyle = C.suitBlack;
  ctx.beginPath();
  ctx.moveTo(-tw, B.torsoTop); ctx.lineTo(tw, B.torsoTop); ctx.lineTo(ww, B.torsoBot); ctx.lineTo(-ww, B.torsoBot);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = C.suitRed;
  ctx.beginPath();
  ctx.moveTo(-tw + B.panelW, B.torsoTop); ctx.lineTo(tw - B.panelW, B.torsoTop);
  ctx.lineTo(ww - B.panelW * 0.5, B.torsoBot); ctx.lineTo(-ww + B.panelW * 0.5, B.torsoBot);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = C.suitDark;
  ctx.fillRect(-B.spineW * 0.5, B.torsoTop, B.spineW, B.torsoBot - B.torsoTop);

  // masked head with black web seams
  ctx.fillStyle = C.suitRed;
  ctx.beginPath(); ctx.arc(0, B.headY, B.headR, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = C.suitBlack;
  ctx.lineWidth = B.seamW;
  ctx.beginPath();
  ctx.moveTo(0, B.headY - B.headR); ctx.lineTo(0, B.headY + B.headR);
  ctx.moveTo(-B.headR, B.headY); ctx.quadraticCurveTo(0, B.headY + B.headR * 0.5, B.headR, B.headY);
  ctx.stroke();
  // lens edges peeking past the head outline
  ctx.fillStyle = C.lens;
  ctx.beginPath();
  ctx.ellipse(-B.headR, B.headY, B.headR * B.lensW, B.headR * B.lensH, 0, 0, Math.PI * 2);
  ctx.moveTo(B.headR * (1 + B.lensW), B.headY);
  ctx.ellipse(B.headR, B.headY, B.headR * B.lensW, B.headR * B.lensH, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
