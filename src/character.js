// One continuous implicit suit surface, skinned to the same anatomy used by Cannon.
import { ANATOMY } from './ragdoll.js';
import { CFG } from './config.js';
const TAU = Math.PI * 2;

// Smooth ellipsoid union sampled once at load; no model assets and no per-frame surface generation.
export function skinSurface(step = .022) {
  const min = [-.34, -1.06, -.19], max = [.34, .9, .24];
  const dims = max.map((v, k) => Math.ceil((v - min[k]) / step) + 1);
  const [nx, ny, nz] = dims, points = [], field = [];
  const distance = (p, a) => {
    const r = a.size.map((v, k) => v * (a.name === 'chest' ? (k === 1 ? 1.17 : k === 0 ? 1.06 : 1.03) : 1.03));
    const d = p.map((v, k) => v - a.at[k]);
    if (a.name === 'chest') d[0] /= .78 + .22 * Math.max(0, Math.min(1, (p[1] - .08) / .28));
    if (/upperArm|forearm|thigh|shin/.test(a.name)) {
      const radius = r[0], half = Math.max(0, r[1] - radius);
      const y = Math.max(-half, Math.min(half, d[1]));
      const taper = 1 + .12 * d[1] / r[1];
      return Math.hypot(d[0], d[1] - y, d[2] * r[0] / r[2]) - radius * taper;
    }
    const k0 = Math.hypot(...d.map((v, k) => v / r[k]));
    const k1 = Math.hypot(...d.map((v, k) => v / (r[k] * r[k])));
    return k0 * (k0 - 1) / (k1 || 1);
  };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p = [min[0] + x * step, min[1] + y * step, min[2] + z * step]; points.push(p);
    let d = 100;
    for (const a of ANATOMY) {
      const v = distance(p, a), h = Math.max(.045 - Math.abs(d - v), 0) / .045;
      d = Math.min(d, v) - h * h * .045 * .25;
    }
    field.push(d);
  }
  const positions = [], indices = [], skinIndices = [], weights = [], uvs = [], edges = new Map();
  const edge = (i, j) => {
    const key = i < j ? i * points.length + j : j * points.length + i;
    if (edges.has(key)) return edges.get(key);
    const t = field[i] / (field[i] - field[j]);
    const p = points[i].map((v, k) => v + (points[j][k] - v) * t), id = positions.length / 3;
    positions.push(p[0], p[1], -p[2]);
    const nearest = ANATOMY.map((a, k) => ({ k, d: Math.abs(distance(p, a)) })).sort((a, b) => a.d - b.d);
    const primary = nearest[0], a = ANATOMY[primary.k];
    // Blend only the anatomical parent/child at joints, so neighbouring legs never share weights.
    const related = nearest.filter(n => n.k === primary.k || ANATOMY[n.k].parent === a.name || a.parent === ANATOMY[n.k].name).slice(0, 4);
    const w = related.map(n => Math.exp(-(n.d - primary.d) * 65)), sum = w.reduce((s, v) => s + v, 0);
    for (let k = 0; k < 4; k++) { skinIndices.push(related[k]?.k || 0); weights.push((w[k] || 0) / sum); }
    let u = Math.atan2((p[0] - a.at[0]) / a.size[0], (p[2] - a.at[2]) / a.size[2]) / TAU;
    if (u < 0) u += 1;
    const v = Math.max(.015, Math.min(.985, .5 + (p[1] - a.at[1]) / (2 * a.size[1])));
    uvs.push(u, (primary.k + v) / 16);
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
  return { positions, indices, skinIndices, weights, uvs };
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
  mesh.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones));
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
  return { root: mesh, update, skeleton: mesh.skeleton };
}
