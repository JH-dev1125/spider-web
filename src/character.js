// One continuous implicit suit surface, skinned to the same anatomy used by Cannon.
import { ANATOMY } from './ragdoll.js';
import { CFG } from './config.js';
const TAU = Math.PI * 2;

// Quaternions as [x, y, z, w] arrays (the surface is built without Three or Cannon).
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qrot = (q, v) => qmul(qmul(q, [...v, 0]), [-q[0], -q[1], -q[2], q[3]]).slice(0, 3);
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qz = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
const vadd = (a, b) => a.map((v, k) => v + b[k]), vsub = (a, b) => a.map((v, k) => v - b[k]);
export const PARENT_OF = Object.fromEntries(ANATOMY.map((a) => [a.name, a.parent || null]));

// The bind pose the surface is modelled in: the ragdoll's rest skeleton (the same joint pivots and segment offsets the
// physics uses), with the arms swung out 1.3 rad and the legs 0.26 rad (near a T-pose: the middle of the arms' range, so the shoulder skin stretches least), so no limb surface ever touches a
// part it is not jointed to. {name: {pos, q}} in physics coordinates (y up, +z forward).
export const ARM_OUT = 1.3, LEG_OUT = .26;
export function bindPose() {
  const out = {};
  for (const a of ANATOMY) {
    const sd = a.name.endsWith('L') ? -1 : 1;
    const local = a.name.startsWith('upperArm') ? qz(sd * ARM_OUT) : a.name.startsWith('thigh') ? qz(sd * LEG_OUT) : [0, 0, 0, 1];
    if (!a.parent) { out[a.name] = { pos: a.at.slice(), q: local }; continue; }
    const P = out[a.parent], pa = ANATOMY.find((x) => x.name === a.parent).at, q = qmul(P.q, local);
    out[a.name] = { pos: vadd(vadd(P.pos, qrot(P.q, vsub(a.joint, pa))), qrot(q, vsub(a.at, a.joint))), q };
  }
  return out;
}

// Skin a bind-space point (physics coordinates) with per-part rigid transforms {name: {pos, q}} and its weights.
export function skinPoint(bind, pose, v, idx, w) {
  const out = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    if (!w[k]) continue;
    const n = ANATOMY[idx[k]].name, B = bind[n], P = pose[n];
    const r = vadd(P.pos, qrot(P.q, qrot(qinv(B.q), vsub(v, B.pos))));
    for (let i = 0; i < 3; i++) out[i] += w[k] * r[i];
  }
  return out;
}

// Smooth ellipsoid union sampled once at load; no model assets and no per-frame surface generation.
// Jointed neighbours blend smoothly (the shoulder, elbow, knee); other parts union hard, so they never web together.
// Each vertex is weighted to its own part and its parent, blended toward the joint.
export function skinSurface(step = .022) {
  const bind = bindPose(), local = ANATOMY.map((a) => bind[a.name]);
  const min = [-1.02, -1.06, -.2], max = [1.02, .9, .25];
  const dims = max.map((v, k) => Math.ceil((v - min[k]) / step) + 1);
  const [nx, ny, nz] = dims, points = [], field = [];
  const distance = (p, a) => {
    const r = a.size.map((v, k) => v * (a.name === 'chest' ? (k === 1 ? 1.17 : k === 0 ? 1.06 : 1.03) : 1.03));
    const d = p.map((v, k) => v - a.at[k]);
    if (a.name === 'chest') d[0] /= .78 + .22 * Math.max(0, Math.min(1, (p[1] - .08) / .28));
    if (/upperArm|forearm|thigh|shin/.test(a.name)) {
      const radius = r[0], half = Math.max(0, r[1] - radius);
      // the upper arm's capsule runs on into the shoulder (a deltoid): in any arm pose it stays joined to the chest
      const y = Math.max(-half, Math.min(half + (a.name.startsWith('upperArm') ? .035 : 0), d[1]));
      const taper = 1 + .12 * d[1] / r[1];
      return Math.hypot(d[0], d[1] - y, d[2] * r[0] / r[2]) - radius * taper;
    }
    const k0 = Math.hypot(...d.map((v, k) => v / r[k]));
    const k1 = Math.hypot(...d.map((v, k) => v / (r[k] * r[k])));
    return k0 * (k0 - 1) / (k1 || 1);
  };
  // a bind-space point in part k's rest frame (where the part sits at a.at, axis-aligned)
  const toRest = (p, k) => vadd(qrot(qinv(local[k].q), vsub(p, local[k].pos)), ANATOMY[k].at);
  const parts = (p) => ANATOMY.map((a, k) => distance(toRest(p, k), a));
  const PAIRS = ANATOMY.flatMap((a, k) => a.parent ? [[k, ANATOMY.findIndex((x) => x.name === a.parent)]] : []);
  const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * .25; };
  const blendOf = PAIRS.map(([i]) => ANATOMY[i].name.startsWith('upperArm') ? .1 : .05); // the shoulder: a wider web
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p = [min[0] + x * step, min[1] + y * step, min[2] + z * step]; points.push(p);
    const v = parts(p);
    let d = Math.min(...v);
    PAIRS.forEach(([i, j], k) => { d = Math.min(d, smin(v[i], v[j], blendOf[k])); });
    field.push(d);
  }
  const positions = [], bindPositions = [], indices = [], skinIndices = [], weights = [], uvs = [], edges = new Map();
  const JOINT = .25, HIP = .32; // m of distance difference over which a vertex hands over to its jointed neighbour
  const edge = (i, j) => {
    const key = i < j ? i * points.length + j : j * points.length + i;
    if (edges.has(key)) return edges.get(key);
    const t = field[i] / (field[i] - field[j]);
    const p = points[i].map((v, k) => v + (points[j][k] - v) * t), id = positions.length / 3;
    positions.push(p[0], p[1], -p[2]); bindPositions.push(...p);
    const v = parts(p).map(Math.abs);
    const primary = v.indexOf(Math.min(...v)), a = ANATOMY[primary];
    // the parent takes over toward the joint (weight 1 where the parent's own surface begins: continuous there)
    const other = a.parent ? ANATOMY.findIndex((x) => x.name === a.parent) : -1;
    const u0 = other < 0 ? 1 : Math.max(0, Math.min(1, (v[other] - v[primary]) / (/thigh|upperArm/.test(a.name) ? HIP : JOINT)));
    const wo = (1 - u0) * (1 - u0);
    skinIndices.push(primary, Math.max(other, 0), 0, 0); weights.push(1 - wo, wo, 0, 0);
    const q = toRest(p, primary);
    let u = Math.atan2((q[0] - a.at[0]) / a.size[0], (q[2] - a.at[2]) / a.size[2]) / TAU;
    if (u < 0) u += 1;
    const vv = Math.max(.015, Math.min(.985, .5 + (q[1] - a.at[1]) / (2 * a.size[1])));
    uvs.push(u, (primary + vv) / 16);
    edges.set(key, id); return id;
  };
  const tetra = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
  const face = (ids, inside) => {
    // Orient triangles away from the negative field (reflection to Three flips winding).
    const a = ids.map(i => positions.slice(i * 3, i * 3 + 3));
    const ab = a[1].map((v, k) => v - a[0][k]), ac = a[2].map((v, k) => v - a[0][k]);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const p = points[inside], d = [p[0] - a[0][0], p[1] - a[0][1], -p[2] - a[0][2]];
    if (n.reduce((s, v, k) => s + v * d[k], 0) > 0) indices.push(ids[0], ids[2], ids[1]); else indices.push(...ids);
  };
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const i = x + y * nx + z * nx * ny;
    const cube = [i, i + 1, i + 1 + nx, i + nx, i + nx * ny, i + 1 + nx * ny, i + 1 + nx + nx * ny, i + nx + nx * ny];
    for (const tet of tetra) {
      const a = tet.map(k => cube[k]), inner = a.filter(i => field[i] < 0), outer = a.filter(i => field[i] >= 0);
      if (!inner.length || !outer.length) continue;
      if (inner.length === 1 || outer.length === 1) {
        const one = inner.length === 1 ? inner[0] : outer[0], rest = inner.length === 1 ? outer : inner;
        face(rest.map(j => edge(one, j)), inner[0]);
      } else {
        const q = [edge(inner[0], outer[0]), edge(inner[0], outer[1]), edge(inner[1], outer[1]), edge(inner[1], outer[0])];
        face([q[0], q[1], q[2]], inner[0]); face([q[0], q[2], q[3]], inner[0]);
      }
    }
  }
  return { positions, bindPositions, bind, indices, skinIndices, weights, uvs };
}

function suitTexture(THREE) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 2048;
  const g = c.getContext('2d'), row = 128;
  const spider = (x, y, s, color) => {
    g.strokeStyle = g.fillStyle = color; g.lineWidth = s * .09;
    g.beginPath(); g.ellipse(x, y, s * .12, s * .32, 0, 0, TAU); g.fill();
    for (const sd of [-1, 1]) for (let i = 0; i < 4; i++) {
      const yy = y + (i - 1.5) * s * .13;
      g.beginPath(); g.moveTo(x, yy); g.lineTo(x + sd * s * .5, yy + (i < 2 ? -1 : 1) * s * .22);
      g.lineTo(x + sd * s * .63, yy + (i < 2 ? -1 : 1) * s * .65); g.stroke();
    }
  };
  ANATOMY.forEach((a, index) => {
    const top = (15 - index) * row, blue = /thigh|upperArm|pelvis/.test(a.name);
    g.save(); g.beginPath(); g.rect(0, top, c.width, row); g.clip();
    g.fillStyle = blue ? CFG.character.blue : CFG.colors.suitRed; g.fillRect(0, top, c.width, row);
    if (a.name === 'chest') {
      g.fillStyle = CFG.character.blue;
      for (const u of [.25, .75]) g.fillRect((u - .08) * c.width, top, .16 * c.width, row);
    }
    // Fine fabric weave under the black raised web pattern.
    g.fillStyle = 'rgba(255,255,255,.12)';
    for (let y = 0; y < row; y += 4) for (let x = y % 8; x < c.width; x += 8) g.fillRect(x, top + y, 1, 1);
    if (!blue) {
      g.strokeStyle = 'rgba(14,12,22,.85)'; g.lineWidth = 1.5;
      g.beginPath();
      for (let x = 0; x <= c.width; x += 48) { g.moveTo(x, top); g.lineTo(x + 16, top + row); }
      for (let y = 0; y < row; y += 18) {
        g.moveTo(0, top + y);
        for (let x = 0; x < c.width; x += 48) g.quadraticCurveTo(x + 24, top + y + 9, x + 48, top + y);
      }
      g.stroke();
    }
    if (a.name === 'chest') {
      for (const x of [0, 1024]) spider(x, top + 52, 48, '#080b17');
      spider(512, top + 60, 54, '#080b17');
    }
    if (a.name === 'head') for (const sd of [-1, 1]) {
      // Front wraps across u=0; angular lenses taper toward the nose.
      g.save(); g.translate(sd < 0 ? 1024 : 0, top + 48); g.scale(sd, 1);
      g.beginPath(); g.moveTo(20, 0); g.lineTo(190, -28); g.quadraticCurveTo(182, 35, 82, 31); g.closePath();
      g.fillStyle = '#050812'; g.fill(); g.strokeStyle = '#050812'; g.lineWidth = 12; g.stroke();
      g.fillStyle = '#e9f3ff'; g.fill(); g.restore();
    }
    g.restore();
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

export function createHero(THREE) {
  const data = skinSurface(), geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(data.skinIndices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(data.weights, 4));
  geo.setIndex(data.indices); geo.computeVertexNormals();
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshPhongMaterial({ map: suitTexture(THREE), shininess: 46, specular: 0x485472 }));
  mesh.frustumCulled = false;
  const bones = ANATOMY.map(() => new THREE.Bone());
  ANATOMY.forEach((a, i) => {
    bones[i].name = a.name;
    const parent = ANATOMY.findIndex(b => b.name === a.parent), origin = parent < 0 ? [0, 0, 0] : ANATOMY[parent].at;
    bones[i].position.set(a.at[0] - origin[0], a.at[1] - origin[1], -(a.at[2] - origin[2]));
    if (parent < 0) mesh.add(bones[i]); else bones[parent].add(bones[i]);
  });
  mesh.updateMatrixWorld(true);
  const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), parentQ = new THREE.Quaternion();
  function update(p, out, castSide) {
    ANATOMY.forEach((a, i) => {
      const body = p.ragdoll[a.name], parent = ANATOMY.findIndex(b => b.name === a.parent);
      wp.set(body.position.x, body.position.y, -body.position.z);
      wq.set(-body.quaternion.x, -body.quaternion.y, body.quaternion.z, body.quaternion.w);
      if (parent < 0) { bones[i].position.copy(wp); bones[i].quaternion.copy(wq); }
      else {
        bones[parent].worldToLocal(wp); bones[i].position.copy(wp);
        bones[parent].getWorldQuaternion(parentQ).invert(); bones[i].quaternion.copy(parentQ).multiply(wq);
      }
      bones[i].updateMatrixWorld(true);
    });
    const hand = p.ragdoll['hand' + (castSide || p.webSide)];
    return out.set(hand.position.x, hand.position.y, -hand.position.z);
  }
  // Bind at the surface's own pose (bindPose), so the inverse bind matrices match the vertices exactly.
  const rest = Object.fromEntries(Object.entries(data.bind).map(([n, B]) => [n, {
    position: { x: B.pos[0], y: B.pos[1], z: B.pos[2] }, quaternion: { x: B.q[0], y: B.q[1], z: B.q[2], w: B.q[3] } }]));
  update({ ragdoll: rest, webSide: 'R' }, new THREE.Vector3());
  mesh.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones));
  return { root: mesh, update, skeleton: mesh.skeleton };
}
