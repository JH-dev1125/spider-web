// Procedural articulated hero. three.js is passed in (createHero(THREE)) so this module stays importable in
// Node: the pose math below is tested there. Coordinates inside the rig are three.js ones (see render.js):
// the rig's +y is head-up and its chest faces +z.
import { CFG } from './config.js';

const K = CFG.character;
const C = CFG.colors;
const TAU = Math.PI * 2;

export const JOINTS = ['spine', 'neck', 'shL', 'elL', 'shR', 'elR', 'hipL', 'knL', 'hipR', 'knR'];
const SWAP = { shL: 'shR', shR: 'shL', elL: 'elR', elR: 'elL', hipL: 'hipR', hipR: 'hipL', knL: 'knR', knR: 'knL' };
const isLeft = (j) => j.endsWith('L');

// Target joint Eulers for a pose, flat [x, y, z] per JOINTS entry. mirror = web in the left hand.
export function poseTarget(pose, t, mirror, out = new Float64Array(JOINTS.length * 3)) {
  const P = K.poses[pose] || K.poses.glide;
  JOINTS.forEach((j, i) => {
    const v = P[mirror && SWAP[j] ? SWAP[j] : j];
    const s = SWAP[j] ? (isLeft(j) ? -1 : 1) : mirror ? -1 : 1; // see the config comment on mirrored signs
    out[i * 3] = v[0];
    out[i * 3 + 1] = v[1] * s;
    out[i * 3 + 2] = v[2] * s;
  });
  if (P.run) { // wall run: legs stride in opposite phase, knees bend most as each leg swings through
    const a = K.runAmp * P.run, ph = t * K.runFreq;
    out[JOINTS.indexOf('hipL') * 3] += a * Math.sin(ph);
    out[JOINTS.indexOf('hipR') * 3] -= a * Math.sin(ph);
    out[JOINTS.indexOf('knL') * 3] += a * 0.8 * Math.max(0, Math.cos(ph));
    out[JOINTS.indexOf('knR') * 3] += a * 0.8 * Math.max(0, -Math.cos(ph));
  }
  if (P.flail) { // fall: arms and legs thrash out of phase
    const f = K.flailAmp * P.flail;
    for (const [j, axis, ph] of [['shL', 2, 0], ['shR', 2, 2], ['elL', 0, 1], ['elR', 0, 3], ['hipL', 0, 4], ['hipR', 0, 5]]) {
      out[JOINTS.indexOf(j) * 3 + axis] += f * Math.sin(t * K.flailSpeed + ph);
    }
  }
  return out;
}

// Frame-rate independent ease of cur toward target.
export function blendPose(cur, target, dt) {
  const a = 1 - Math.exp(-K.blendRate * dt);
  for (let i = 0; i < cur.length; i++) cur[i] += (target[i] - cur[i]) * a;
  return cur;
}

// Trick flip angle (one full turn over CFG.trickSec, eased) for roll/tuck, 0 otherwise.
export function flipAngle(pose, sec) {
  if (pose !== 'roll' && pose !== 'tuck') return 0;
  const p = Math.min(1, Math.max(0, sec / CFG.trickSec));
  return TAU * p * p * (3 - 2 * p);
}

// ---- textures, made once ----
function canvasTex(THREE, w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function webLines(g, cx, cy, r, n, rings) { // radials + sagging rings around (cx, cy)
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  for (let k = 1; k <= rings; k++) {
    const rr = (r * k) / rings;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU, am = ((i - 0.5) / n) * TAU, rs = rr * 0.86;
      if (i === 0) g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      else g.quadraticCurveTo(cx + Math.cos(am) * rs, cy + Math.sin(am) * rs, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  }
  g.stroke();
}
function spider(g, x, y, s) { // emblem: body + 8 bent legs
  g.fillStyle = C.suitBlack; g.strokeStyle = C.suitBlack; g.lineWidth = s * 0.12;
  g.beginPath(); g.ellipse(x, y - s * 0.25, s * 0.22, s * 0.3, 0, 0, TAU); g.ellipse(x, y + s * 0.45, s * 0.28, s * 0.5, 0, 0, TAU); g.fill();
  for (const sd of [-1, 1]) for (let i = 0; i < 4; i++) {
    const y0 = y - s * 0.3 + i * s * 0.22, kx = x + sd * s * 0.9, ky = y0 + (i < 2 ? -s * 0.5 : s * 0.5);
    g.beginPath(); g.moveTo(x, y0); g.lineTo(kx, ky); g.lineTo(x + sd * s * 1.1, ky + (i < 2 ? s * 0.6 : s * 0.9)); g.stroke();
  }
}
const redWeb = (g, w, h) => {
  g.fillStyle = C.suitRed; g.fillRect(0, 0, w, h);
  g.strokeStyle = C.suitBlack; g.lineWidth = 1.2;
  webLines(g, w / 2, h / 2, w * 0.75, 18, 12);
};

// LatheGeometry u = 0 faces +z (the chest), 0.5 faces -z (the back).
function torsoTex(g, w, h) {
  redWeb(g, w, h);
  g.fillStyle = K.blue; // blue side panels
  for (const u of [0.25, 0.75]) g.fillRect(w * (u - 0.09), 0, w * 0.18, h);
  for (const x of [0, w, w / 2]) spider(g, x, h * 0.4, h * 0.11); // chest (u = 0, wraps to 1) and back
}

export function createHero(THREE) {
  const red = new THREE.MeshPhongMaterial({ map: canvasTex(THREE, 512, 512, redWeb), shininess: 32, specular: 0x553344 });
  const torsoMat = new THREE.MeshPhongMaterial({ map: canvasTex(THREE, 512, 512, torsoTex), shininess: 32, specular: 0x553344 });
  const blue = new THREE.MeshPhongMaterial({ color: K.blue, shininess: 24, specular: 0x223355 });
  const black = new THREE.MeshBasicMaterial({ color: C.suitBlack });
  const lens = new THREE.MeshPhongMaterial({ color: C.lens, shininess: 100, specular: 0xffffff, side: THREE.DoubleSide });
  black.side = THREE.DoubleSide;

  const root = new THREE.Group(); // position + eased orientation
  const body = new THREE.Group(); // trick flips
  root.add(body);
  const joint = (parent, x, y, z = 0) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };
  const mesh = (parent, geo, mat, y, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat); m.position.y = y; m.scale.set(sx, sy, sz); parent.add(m); return m;
  };
  const cap = (r, len, taper = 0) => {
    const geo = new THREE.CapsuleGeometry(r, len, 4, 12), p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = 1 + taper * p.getY(i) / (len / 2 + r);
      p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
    }
    geo.computeVertexNormals(); return geo;
  };
  const ball = new THREE.SphereGeometry(1, 20, 14);

  // Pelvis at player.pos; long legs and a narrow waist under a tapered rib cage.
  mesh(body, ball, blue, -0.02, 0.145, 0.12, 0.105);
  const J = {};
  J.spine = joint(body, 0, 0.03);
  const torso = new THREE.LatheGeometry([
    [0.11, 0], [0.125, 0.08], [0.145, 0.22], [0.187, 0.37], [0.18, 0.44], [0.10, 0.51], [0.065, 0.54],
  ].map(([r, y]) => new THREE.Vector2(r, y)), 24);
  mesh(J.spine, torso, torsoMat, 0, 1, 1, 0.68);
  J.neck = joint(J.spine, 0, 0.55);
  mesh(J.neck, cap(0.059, 0.04), red, 0.01);
  const head = mesh(J.neck, ball, red, 0.14, 0.102, 0.13, 0.106);
  for (const sd of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(0.1, 0.19); shape.lineTo(0.78, 0.43);
    shape.quadraticCurveTo(0.76, -0.25, 0.38, -0.25);
    shape.quadraticCurveTo(0.17, -0.17, 0.1, 0.19);
    const eyeGeo = (scale, offset) => {
      // Subdivide before projecting: a flat lens chord otherwise disappears inside the mask.
      let geo = new THREE.ShapeGeometry(shape, 8).toNonIndexed();
      for (let pass = 0; pass < 2; pass++) {
        const p = geo.attributes.position, vertices = [];
        for (let i = 0; i < p.count; i += 3) {
          const a = new THREE.Vector3().fromBufferAttribute(p, i), b = new THREE.Vector3().fromBufferAttribute(p, i + 1), c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
          const ab = a.clone().lerp(b, 0.5), bc = b.clone().lerp(c, 0.5), ca = c.clone().lerp(a, 0.5);
          for (const v of [a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca]) vertices.push(v.x, v.y, v.z);
        }
        geo.dispose(); geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      }
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = 0.42 + (p.getX(i) - 0.42) * scale, y = 0.08 + (p.getY(i) - 0.08) * scale;
        p.setXYZ(i, x, y, Math.sqrt(Math.max(0.05, 1 - x * x - y * y)) + offset);
      }
      geo.computeVertexNormals(); return geo;
    };
    mesh(head, eyeGeo(1, 0.018), black, 0, sd, 1, 1);
    mesh(head, eyeGeo(0.8, 0.035), lens, 0, sd, 1, 1);
  }
  for (const sd of [-1, 1]) {
    const s = sd < 0 ? 'L' : 'R';
    const sh = J['sh' + s] = joint(J.spine, sd * 0.20, 0.44);
    mesh(sh, ball, red, 0, 0.056, 0.062, 0.055);
    mesh(sh, cap(0.052, 0.22, 0.12), blue, -0.13);
    const el = J['el' + s] = joint(sh, 0, -0.31);
    mesh(el, cap(0.043, 0.23, 0.25), red, -0.145);
    mesh(el, ball, red, -0.32, 0.045, 0.075, 0.035);
    const thumb = mesh(el, cap(0.015, 0.04), red, -0.30); thumb.position.x = sd * 0.044; thumb.rotation.z = sd * 0.5;
    J['hand' + s] = joint(el, 0, -0.37);
    const hip = J['hip' + s] = joint(body, sd * 0.085, -0.07);
    mesh(hip, cap(0.07, 0.34, 0.2), blue, -0.22, 1, 1, 0.9);
    const kn = J['kn' + s] = joint(hip, 0, -0.46);
    mesh(kn, cap(0.047, 0.33, 0.3), red, -0.215);
    const boot = mesh(kn, ball, red, -0.43, 0.06, 0.055, 0.135);
    boot.position.z = 0.065;
  }

  const cur = poseTarget('glide', 0, false);
  const target = new Float64Array(cur.length);
  const q = new THREE.Quaternion(), qAim = new THREE.Quaternion(), qPar = new THREE.Quaternion();
  const vU = new THREE.Vector3(), vF = new THREE.Vector3(), vX = new THREE.Vector3(), vV = new THREE.Vector3();
  const vS = new THREE.Vector3(), vD = new THREE.Vector3(), m = new THREE.Matrix4();
  const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, -1);
  const AX_X = new THREE.Vector3(1, 0, 0), AX_Z = new THREE.Vector3(0, 0, 1);
  let pose = null, poseSec = 0, mirror = false, ikW = 0, first = true;

  // basis: rig +y along u, chest (+z) toward f (orthogonalised against u)
  function aimBasis(u, f, out) {
    vU.copy(u).normalize();
    vF.copy(f).addScaledVector(vU, -f.dot(vU));
    if (vF.lengthSq() < 1e-6) vF.copy(FWD).addScaledVector(vU, -FWD.dot(vU));
    if (vF.lengthSq() < 1e-6) vF.set(0, -1, 0); // u straight along -z: chest down
    vF.normalize();
    vX.crossVectors(vU, vF);
    return out.setFromRotationMatrix(m.makeBasis(vX, vU, vF));
  }

  // pos/vel/anchor/aimAt are three.js coords (Vector3); aimAt = where the web arm points, or null.
  // wall = player.wall (the run's face normal x, 0 when not wall-running).
  function update(poseName, t, dt, pos, vel, anchor, aimAt, out, wall = 0) {
    if (poseName !== pose) { pose = poseName; poseSec = 0; } else poseSec += dt;
    const aim = anchor || aimAt;
    if (aim) mirror = aim.x < pos.x;
    else if (pose === 'wallrun' && wall) mirror = wall < 0; // the free arm (shR, or shL mirrored) reaches off the wall
    blendPose(cur, poseTarget(pose, t, mirror, target), first ? 1e9 : dt);
    JOINTS.forEach((j, i) => J[j].rotation.set(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]));

    // body orientation: hang under the rope, spread flat in a glide, upright for tricks and falls
    vV.copy(vel);
    const horiz = vS.set(vel.x, 0, vel.z);
    if (pose === 'wallrun' && wall) aimBasis(vD.set(wall * 0.75, 0.65, 0), horiz.lengthSq() > 1 ? horiz : FWD, q); // feet on the face, tilted off it, running along it
    else if (anchor) aimBasis(vD.subVectors(anchor, pos), vV, q);
    else if (pose === 'glide') aimBasis(vV.lengthSq() > 1 ? vV : FWD, vD.set(0, -1, 0), q);
    else aimBasis(vD.copy(UP).addScaledVector(horiz.normalize(), 0.35), horiz, q);
    if (first) root.quaternion.copy(q);
    else root.quaternion.slerp(q, 1 - Math.exp(-K.turnRate * dt));
    const flip = flipAngle(pose, poseSec); // on a child node so it never feeds back into the eased base
    if (pose === 'tuck') body.quaternion.setFromAxisAngle(AX_X, flip);
    else body.quaternion.setFromAxisAngle(AX_Z, mirror ? flip : -flip);
    root.position.copy(pos);
    root.updateMatrixWorld(true);

    // IK-lite: point the web arm's shoulder straight at the anchor (or the flying web's target)
    ikW += ((aim ? 1 : 0) - ikW) * (first ? 1 : 1 - Math.exp(-K.blendRate * dt));
    const sh = mirror ? J.shL : J.shR;
    if (aim && ikW > 0.01) {
      sh.getWorldPosition(vS);
      J.spine.getWorldQuaternion(qPar).invert();
      vD.subVectors(aim, vS).applyQuaternion(qPar).normalize();
      qAim.setFromUnitVectors(DOWN, vD);
      sh.quaternion.slerp(qAim, ikW);
      (mirror ? J.elL : J.elR).rotation.set(0, 0, 0);
      sh.updateMatrixWorld(true);
    }
    first = false;
    return (mirror ? J.handL : J.handR).getWorldPosition(out);
  }

  return { root, update };
}
