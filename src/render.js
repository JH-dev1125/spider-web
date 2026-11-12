// three.js renderer. The only module that imports 'three' (import map in index.html).
//
// Coordinates: world (x right, y up, z forward) maps to three.js as (x, y, -z). three's camera looks down -z,
// so "forward" stays into the screen and +x stays on the right. All world -> three conversion goes through
// set3() / the -z writes below.
import * as THREE from 'three';
import { CFG } from './config.js';
import { hash01 } from './world.js';
import { followCamera, shakeOffset, speedLineK, wrapZ, surfaceNormal } from './render-math.js';
import { createHero } from './character.js';

const R = CFG.render;
const C = CFG.colors;
const set3 = (v, o) => v.set(o.x, o.y, -o.z);
const srgb = ([r, g, b]) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);

// scale+translate matrix straight into an InstancedMesh's array (no Object3D per instance)
function setST(mesh, i, x, y, z, sx, sy, sz) {
  const e = mesh.instanceMatrix.array, o = i * 16;
  e.fill(0, o, o + 16);
  e[o] = sx; e[o + 5] = sy; e[o + 10] = sz;
  e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return new THREE.CanvasTexture(c);
}

// Window tile: R = glass mask, G = lit amount. A data texture, sampled in world metres by the facade shader.
function windowTexture(style) {
  const [gw, gh] = R.windowStyles[style];
  const cell = 32;
  const t = canvasTexture(R.texCols * cell, R.texRows * cell, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, R.texCols * cell, R.texRows * cell);
    for (let r = 0; r < R.texRows; r++) for (let c = 0; c < R.texCols; c++) {
      const h = hash01(style * 1000 + r * 31 + c);
      const lit = h < R.windowLit ? 120 + Math.floor(135 * hash01(h * 1e6)) : 0;
      g.fillStyle = `rgb(255,${lit},0)`;
      g.fillRect((c + (1 - gw) / 2) * cell, (r + (1 - gh) / 2) * cell, gw * cell, gh * cell);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.magFilter = THREE.NearestFilter; // crisp window edges up close (mips still smooth the distance)
  return t;
}

// Facade shader: world-space window UVs (floors floorH, columns windowColSpacing), per-instance tint + seed,
// lit windows emissive, dark roofs, three's exp2 fog.
function facadeMaterial(sunDir) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    sunDir: { value: sunDir }, litColor: { value: srgb(C.windowLit) }, roof: { value: new THREE.Color(C.roof) },
    cell: { value: new THREE.Vector2(R.windowColSpacing * R.texCols, R.floorH * R.texRows) },
  }]);
  R.windowStyles.forEach((_, i) => { uniforms['map' + i] = { value: windowTexture(i) }; });
  return new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    vertexShader: `
      attribute vec4 aInfo; // rgb tint, style + seed (integer part = style)
      varying vec3 vW; varying vec3 vN; varying vec4 vInfo;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = wp.xyz; vN = normal; vInfo = aInfo;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D map0; uniform sampler2D map1; uniform sampler2D map2;
      uniform vec3 sunDir; uniform vec3 litColor; uniform vec3 roof; uniform vec2 cell;
      varying vec3 vW; varying vec3 vN; varying vec4 vInfo;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec3 n = normalize(vN);
        vec3 tint = vInfo.rgb;
        float light = 0.5 + 0.35 * max(dot(n, sunDir), 0.0) + 0.15 * n.y;
        vec3 col;
        if (n.y > 0.5) col = roof * (0.7 + 0.6 * tint);
        else {
          vec2 uv = (abs(n.x) > 0.5 ? vec2(vW.z, vW.y) : vec2(vW.x, vW.y)) / cell + fract(vInfo.a) * vec2(17.0, 5.0);
          float style = floor(vInfo.a);
          vec4 t = style < 0.5 ? texture2D(map0, uv) : style < 1.5 ? texture2D(map1, uv) : texture2D(map2, uv);
          float brickRow = floor(vW.y / 0.24);
          vec2 brick = vec2(fract((abs(n.x) > 0.5 ? vW.z : vW.x) / 0.55 + mod(brickRow, 2.0) * 0.5), fract(vW.y / 0.24));
          float mortar = step(0.94, brick.x) + step(0.9, brick.y);
          if (style < 0.5) tint = mix(tint * vec3(1.35, 0.78, 0.63), tint * 0.55, min(mortar, 1.0));
          if (style > 0.5 && style < 1.5) tint *= 0.9 + 0.1 * step(0.04, fract(vW.y / 3.0));
          vec3 glass = mix(tint * vec3(0.22, 0.36, 0.5) + vec3(0.035, 0.055, 0.085) * (0.5 + 0.5 * sin(vW.y * 0.035)), litColor * (0.7 + 0.6 * fract(vInfo.a * 7.0)), t.g);
          col = mix(tint * light, glass, t.r);
          col *= 0.75 + 0.25 * smoothstep(0.0, 40.0, vW.y); // darker toward the street
        }
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

function skyMaterial(sunDir, fogColor) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(C.skyTop) }, mid: { value: new THREE.Color(C.skyMid) },
      horizon: { value: new THREE.Color(C.skyHorizon) }, fogc: { value: fogColor }, sunDir: { value: sunDir },
    },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 fogc; uniform vec3 sunDir; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(mix(fogc, horizon, smoothstep(-0.02, 0.1, h)), mid, smoothstep(0.08, 0.3, h));
        col = mix(col, top, smoothstep(0.25, 0.8, h));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.62, 0.32) * (pow(s, 6.0) * 0.45 + pow(s, 60.0) * 1.2) + vec3(1.0, 0.9, 0.75) * smoothstep(0.9993, 0.9996, s);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

function splatTexture() {
  const t = canvasTexture(128, 128, (g) => {
    g.strokeStyle = '#fff'; g.lineWidth = 3;
    g.beginPath();
    for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; g.moveTo(64, 64); g.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62); }
    for (const r of [14, 28, 42, 56]) g.moveTo(64 + r, 64), g.arc(64, 64, r, 0, Math.PI * 2);
    g.stroke();
  });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createRenderer(canvas) {
  const gl = new THREE.WebGLRenderer({ canvas, antialias: (window.devicePixelRatio || 1) < 2, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(C.skyHorizon).lerp(new THREE.Color(C.skyMid), 0.45);
  scene.fog = new THREE.FogExp2(fogColor, R.fogDensity);
  const camera = new THREE.PerspectiveCamera(R.fovMin, 16 / 9, R.near, R.far);
  scene.add(camera); // speed lines ride on it

  const sunDir = new THREE.Vector3(R.sunDir[0], R.sunDir[1], -R.sunDir[2]).normalize();
  scene.add(new THREE.HemisphereLight(0x8a90d8, 0x2a1a30, 1.6));
  const key = new THREE.DirectionalLight(0xffc89a, 1.8); // warm dusk light from behind-above the camera
  key.position.set(-0.4, 1, 0.8);
  scene.add(key);

  const sky = new THREE.Mesh(new THREE.SphereGeometry(R.far * 0.9, 24, 12), skyMaterial(sunDir, fogColor));
  sky.renderOrder = -1;
  scene.add(sky);

  // street: one big plane that follows the camera
  const street = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: C.street }));
  street.rotation.x = -Math.PI / 2;
  scene.add(street);

  // ---- structures: id-keyed detail records, uploaded only when boxes enter or leave ----
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const facade = facadeMaterial(sunDir);
  const instanced = (geo, mat, n) => {
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.frustumCulled = false; // instances span the whole city; bounds would need recomputing every change
    m.count = 0;
    scene.add(m);
    return m;
  };
  const withInfo = (m, n) => {
    m.geometry = m.geometry.clone();
    m.geometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    return m.geometry.attributes.aInfo;
  };
  const skyline = instanced(box, facade, R.skylineCount);
  const skylineInfo = withInfo(skyline, R.skylineCount);
  const metal = new THREE.MeshLambertMaterial({ color: '#87909d' });
  const steel = new THREE.MeshLambertMaterial({ color: '#43596a' });
  const yellow = new THREE.MeshLambertMaterial({ color: '#e9ad29' });
  const tankMat = new THREE.MeshLambertMaterial({ color: '#654c40' });
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0);
  const coneGeo = new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0);
  const records = new Map(), batches = new Map();
  // Parts share one draw per material/geometry, including diagonals in the crane lattice.
  const partMatrix = new THREE.Matrix4(), partQ = new THREE.Quaternion();
  const partPos = new THREE.Vector3(), partScale = new THREE.Vector3(), partDir = new THREE.Vector3();
  const partUp = new THREE.Vector3(0, 1, 0);
  function upload(name, geo, mat, parts, isFacade = false) {
    let m = batches.get(name);
    if (!m || parts.length > m.instanceMatrix.count) {
      if (m) { scene.remove(m); m.dispose(); if (isFacade) m.geometry.dispose(); }
      m = instanced(geo, mat, Math.max(16, 2 ** Math.ceil(Math.log2(parts.length || 1))));
      if (isFacade) withInfo(m, m.instanceMatrix.count);
      batches.set(name, m);
    }
    m.count = parts.length;
    parts.forEach((p, i) => {
      if (p.end) {
        partPos.set(p.x, p.y, p.z); partDir.copy(p.end).sub(partPos);
        const len = partDir.length(); partQ.setFromUnitVectors(partUp, partDir.divideScalar(len));
        m.setMatrixAt(i, partMatrix.compose(partPos, partQ, partScale.set(p.sx, len, p.sz)));
      } else setST(m, i, p.x, p.y, p.z, p.sx, p.sy, p.sz);
      if (isFacade) writeInfo(m.geometry.attributes.aInfo, i, p.color, p.style);
    });
    m.instanceMatrix.needsUpdate = true;
    if (isFacade) m.geometry.attributes.aInfo.needsUpdate = true;
  }

  const tints = R.facadeTints.map(srgb);
  const skyTints = R.skylineTints.map(srgb);
  const writeInfo = (attr, i, color, seed) => attr.setXYZW(i, color.r, color.g, color.b, seed);

  // skyline: world-fixed boxes that wrap around the camera z (pop-in happens deep in the fog)
  const SKY = Array.from({ length: R.skylineCount }, (_, i) => {
    const h = (k) => hash01(i * 7 + k + 9001);
    const side = h(0) < 0.5 ? -1 : 1;
    const xx = R.skylineXMin + (R.skylineXMax - R.skylineXMin) * h(1) ** 1.3;
    const far = (xx - R.skylineXMin) / (R.skylineXMax - R.skylineXMin);
    const s = { x: side * xx, z: h(2) * R.skylineSpan, w: 18 + 34 * h(3), d: 18 + 34 * h(4), h: 40 + (90 + 200 * far) * h(5) };
    writeInfo(skylineInfo, i, skyTints[i % skyTints.length], Math.floor(h(6) * 3) + h(7) * 0.99);
    return s;
  });
  skyline.count = R.skylineCount;
  skylineInfo.needsUpdate = true;

  function describe(s, close) {
    const { min: a, max: b, kind } = s;
    const prefix = s.id.split(':')[0];
    let seed = 0; for (const c of prefix) seed = (seed * 31 + c.charCodeAt(0)) | 0;
    const h = k => hash01(Math.abs(seed) + k * 137);
    const x = (a.x + b.x) / 2, z = -(a.z + b.z) / 2;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const parts = { solid: [], trim: [], steel: [], yellow: [], tank: [], roof: [] };
    const add = (batch, x, y, z, sx, sy, sz) => {
      const p = { x, y, z, sx, sy, sz }; parts[batch].push(p); return p;
    };
    const solid = () => Object.assign(add('solid', x, a.y, z, dx, dy, dz), {
      color: tints[Math.floor(h(1) * tints.length)], style: Math.floor(h(2) * 3) + h(3) * 0.99,
    });
    const beam = (batch, ax, ay, az, bx, by, bz, width) => {
      const p = add(batch, ax, ay, az, width, 1, width); p.end = new THREE.Vector3(bx, by, bz);
    };
    if (kind === 'frame') {
      // Every physics beam is an I section; never fill the hollow lot with a facade.
      if (dy > dx && dy > dz) {
        for (const side of [-1, 1]) add('steel', x, a.y, z + side * (dz / 2 - 0.12), dx, dy, 0.24);
        add('steel', x, a.y, z, 0.22, dy, dz);
      } else if (dx > dz) {
        for (const yy of [a.y, b.y - 0.2]) add('steel', x, yy, z, dx, 0.2, dz);
        add('steel', x, a.y, z, dx, dy, 0.2);
      } else {
        for (const yy of [a.y, b.y - 0.2]) add('steel', x, yy, z, dx, 0.2, dz);
        add('steel', x, a.y, z, 0.2, dy, dz);
      }
    } else if (kind === 'crane') {
      const mast = dy > dx && dy > dz;
      if (mast) {
        for (const xx of [a.x + 0.14, b.x - 0.14]) for (const zz of [-a.z - 0.14, -b.z + 0.14]) add('yellow', xx, a.y, zz, 0.28, dy, 0.28);
        for (let y = a.y; y < b.y; y += 4) {
          const top = Math.min(y + 4, b.y);
          for (const zz of [-a.z - 0.14, -b.z + 0.14]) beam('yellow', a.x + 0.14, y, zz, b.x - 0.14, top, zz, 0.13);
          for (const xx of [a.x + 0.14, b.x - 0.14]) beam('yellow', xx, y, -a.z - 0.14, xx, top, -b.z + 0.14, 0.13);
          add('yellow', x, y, z, dx, 0.14, dz);
        }
      } else {
        for (const yy of [a.y, b.y - 0.18]) for (const zz of [-a.z - 0.1, -b.z + 0.1]) add('yellow', x, yy, zz, dx, 0.18, 0.18);
        for (let xx = a.x; xx < b.x; xx += 3) {
          for (const zz of [-a.z - 0.1, -b.z + 0.1]) beam('yellow', xx, a.y, zz, Math.min(xx + 3, b.x), b.y, zz, 0.12);
        }
        add('yellow', x, a.y + 0.2, z, 3, dy - 0.4, dz * 0.8); // solid operator cabin
      }
    } else if (kind === 'bridge') {
      const p = solid(); p.style = 2.03; p.color = tints[2];
      for (const yy of [a.y, b.y - 0.25]) add('steel', x, yy, z, dx, 0.25, dz + 0.15);
      for (let xx = a.x + 1; xx < b.x; xx += 2.5) for (const zz of [-a.z, -b.z]) add('trim', xx, a.y, zz, 0.12, dy, 0.16);
    } else if (kind === 'ledge') {
      add('trim', x, a.y, z, dx, dy, dz);
      add('steel', x, b.y - 0.12, z, dx + 0.12, 0.12, dz + 0.12);
    } else {
      solid();
      const face = x < 0 ? b.x : a.x, sd = x < 0 ? 1 : -1;
      // Thin cornices, masonry sills, and stacked balconies break up the wall silhouette.
      for (const yy of [a.y, b.y - 0.45]) add('trim', x, yy, z, dx + 0.5, 0.45, dz + 0.5);
      const style = Math.floor(h(2) * 3);
      // Keep distant facades legible without spending triangles on every small sill.
      for (let yy = a.y + 3; yy < b.y - 1; yy += close ? 3 : 6) {
        if (style === 2) add('steel', face + sd * 0.07, yy, z, 0.14, 0.09, dz);
        else for (let zz = a.z + 1.25; zz < b.z - 1; zz += close ? 2.5 : 5) {
          add('trim', face + sd * 0.15, yy, -zz, 0.35, 0.12, 1.7);
          if (style === 1 && Math.floor((zz - a.z) / 2.5) % 4 === 1 && yy % 9 < 3) {
            add('trim', face + sd * 0.3, yy - 0.12, -zz, 0.7, 0.16, 2.1);
            add('steel', face + sd * 0.65, yy, -zz, 0.08, 0.65, 2.1);
          }
        }
      }
      const exposed = !listHasUpper(s);
      if (exposed) {
        if (h(4) < R.tankChance) {
          add('steel', x, b.y, z, 3.8, 0.25, 3.8);
          for (const xx of [-1.3, 1.3]) for (const zz of [-1.3, 1.3]) add('steel', x + xx, b.y, z + zz, 0.18, 1.5, 0.18);
          add('tank', x, b.y + 1.4, z, 1.8, 3.7, 1.8);
          add('roof', x, b.y + 5.1, z, 2.0, 1, 2.0);
          for (const yy of [b.y + 1.6, b.y + 4.6]) add('steel', x, yy, z, 3.7, 0.13, 3.7);
        }
        for (let i = 0; i < 3; i++) {
          const ax = x + (h(8 + i) - 0.5) * (dx - 5), az = z + (h(12 + i) - 0.5) * (dz - 5);
          add('trim', ax, b.y, az, 2.4, 1.3, 1.8);
          for (let k = 0; k < 4; k++) add('steel', ax, b.y + 0.2 + k * 0.24, az + 0.91, 2.1, 0.07, 0.05);
        }
        if (h(14) < R.antennaChance) {
          const ax = x + dx * 0.24, ah = R.antennaH * (0.6 + 0.8 * h(17));
          add('steel', ax, b.y, z, 0.12, ah, 0.12);
          for (let i = 0; i < 3; i++) add('steel', ax, b.y + ah - i * 1.4, z, 2.7 - i * 0.5, 0.08, 0.08);
        }
      }
    }
    return parts;
  }
  let upperIds = new Set();
  const listHasUpper = s => s.kind === 'tower' && upperIds.has(s.id.split(':')[0]);
  function syncStructures(list, heroZ) {
    const ids = new Set(list.map(s => s.id));
    let changed = false;
    for (const id of records.keys()) if (!ids.has(id)) { records.delete(id); changed = true; }
    upperIds = new Set(list.filter(s => s.kind === 'setback').map(s => s.id.split(':')[0]));
    for (const s of list) {
      const close = s.max.z > heroZ - 20 && s.min.z < heroZ + 100;
      const signature = `${s.kind}|${s.min.x},${s.min.y},${s.min.z}|${s.max.x},${s.max.y},${s.max.z}|${s.attach}|${listHasUpper(s)}|${close}`;
      if (records.get(s.id)?.signature === signature) continue;
      records.set(s.id, { signature, parts: describe(s, close) }); changed = true;
    }
    if (!changed) return;
    const all = { solid: [], trim: [], steel: [], yellow: [], tank: [], roof: [] };
    for (const { parts } of records.values()) for (const key of Object.keys(all)) all[key].push(...parts[key]);
    upload('solid', box, facade, all.solid, true);
    upload('trim', box, metal, all.trim); upload('steel', box, steel, all.steel);
    upload('yellow', box, yellow, all.yellow); upload('tank', tankGeo, tankMat, all.tank);
    upload('roof', coneGeo, steel, all.roof);
  }

  // ---- street: shared low-poly traffic batches, both directions ----
  const lightsPerX = Math.ceil(R.streetSpan / R.streetLightSpacing);
  const carsPerLane = Math.ceil(R.streetSpan / R.carSpacing);
  const nCars = R.carLanes.length * carsPerLane;
  const nLamps = R.streetLightXs.length * lightsPerX;
  const nGlow = nLamps + nCars * 4;
  const glow = instanced(box, new THREE.MeshBasicMaterial(), nGlow);
  const cars = instanced(box, new THREE.MeshLambertMaterial(), nCars);
  const cabinGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const cp = cabinGeo.attributes.position;
  for (let i = 0; i < cp.count; i++) if (cp.getY(i) > 0.5) {
    cp.setX(i, cp.getX(i) * 0.82); cp.setZ(i, cp.getZ(i) * 0.74);
  }
  cabinGeo.computeVertexNormals();
  const cabins = instanced(cabinGeo, new THREE.MeshPhongMaterial({ color: '#253e50', shininess: 90 }), nCars);
  const wheels = instanced(new THREE.CylinderGeometry(0.36, 0.36, 0.22, 8).rotateZ(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: '#10131a' }), nCars * 4);
  const signs = instanced(box, new THREE.MeshBasicMaterial({ color: '#ffda64' }), nCars);
  const poles = instanced(box, steel, nLamps);
  const markings = instanced(box, new THREE.MeshBasicMaterial({ color: '#aa966b' }), lightsPerX * 3);
  const carTypes = Array.from({ length: nCars }, (_, i) => {
    const h = hash01(i + 819);
    const type = h < 0.12 ? 'bus' : h < 0.42 ? 'taxi' : 'sedan';
    cars.setColorAt(i, new THREE.Color(type === 'taxi' ? '#f6bc27' : type === 'bus' ? '#c2c9c1' : ['#637c97', '#bb4445', '#b2bac0', '#334650'][i % 4]));
    return type;
  });
  const lampColor = new THREE.Color(C.streetLight), headColor = new THREE.Color(C.carHead), tailColor = new THREE.Color(C.carTail);
  for (let i = 0; i < nLamps; i++) glow.setColorAt(i, lampColor);
  for (let i = nLamps; i < nGlow; i++) glow.setColorAt(i, (i - nLamps) % 4 < 2 ? headColor : tailColor);
  glow.count = nGlow;
  function syncStreet(camZ, t) {
    let i = 0, vehicle = 0, wheel = 0, sign = 0, mark = 0;
    const back = R.streetSpan * 0.3;
    for (const x of R.streetLightXs) for (let k = 0; k < lightsPerX; k++) {
      const z = wrapZ(k * R.streetLightSpacing, camZ, back, R.streetSpan);
      setST(poles, i, x, 0, -z, 0.14, R.streetLightY, 0.14);
      setST(glow, i++, x, R.streetLightY, -z, 0.5, 0.25, 0.5);
    }
    poles.count = i;
    for (const x of [-5.5, 0, 5.5]) for (let k = 0; k < lightsPerX; k++) {
      const z = wrapZ(k * R.streetLightSpacing, camZ, back, R.streetSpan);
      setST(markings, mark++, x, 0.015, -z, x === 0 ? 0.18 : 0.10, 0.02, 5);
    }
    markings.count = mark;
    for (let li = 0; li < R.carLanes.length; li++) {
      const x = R.carLanes[li], dir = x > 0 ? 1 : -1;
      for (let k = 0; k < carsPerLane; k++) {
        const gone = hash01(k * R.carLanes.length + li) < R.carGapChance;
        const z = wrapZ(k * R.carSpacing + dir * t * R.carSpeed, camZ, back, R.streetSpan);
        const type = carTypes[vehicle], bus = type === 'bus', len = bus ? 9 : 4.4, width = bus ? 2.3 : 1.85;
        const scale = gone ? 0 : 1;
        setST(cars, vehicle, x, 0.4, -z, width * scale, (bus ? 2.5 : 0.65) * scale, len * scale);
        setST(cabins, vehicle++, x, bus ? 1.35 : 1.05, -z, (width - 0.15) * scale, (bus ? 1.2 : 0.65) * scale, (bus ? 8.2 : 2.35) * scale);
        for (const sd of [-1, 1]) for (const end of [-1, 1]) {
          setST(wheels, wheel++, x + sd * width / 2, 0.38, -z + end * len * 0.31, scale, scale, scale);
        }
        for (const end of [1, -1]) for (const sd of [-1, 1]) {
          setST(glow, i++, x + sd * width * 0.34, 0.78, -z - end * dir * (len / 2 + 0.02), 0.28 * scale, 0.17 * scale, 0.08 * scale);
        }
        if (type === 'taxi' && !gone) setST(signs, sign++, x, 1.74, -z, 0.65, 0.22, 0.36);
      }
    }
    cars.count = cabins.count = nCars; wheels.count = wheel; signs.count = sign;
    for (const m of [glow, cars, cabins, wheels, signs, poles, markings]) m.instanceMatrix.needsUpdate = true;
  }

  // ---- hero, rope, web flight, miss line, anchor splat ----
  const hero = createHero(THREE);
  scene.add(hero.root);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0);
  // Each strand is ROPE_SEG instanced pieces whose radius grows with camera distance: ~constant screen width,
  // so a rope that passes beside the lens doesn't turn into a white bar.
  const ROPE_SEG = 16;
  const strand = (opacity) => {
    const m = new THREE.InstancedMesh(cyl, new THREE.MeshBasicMaterial({ color: C.web, transparent: opacity < 1, opacity }), ROPE_SEG);
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const rope = strand(1), flight = strand(1), flightGlow = strand(0.17), miss = strand(0.8);
  flightGlow.material.blending = THREE.AdditiveBlending; flightGlow.material.depthWrite = false;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color: '#f1fbff' }));
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6),
    new THREE.MeshBasicMaterial({ color: '#c3e9ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(tip, flash);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vDir = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  const vP = new THREE.Vector3(), vScale = new THREE.Vector3(), qSeg = new THREE.Quaternion(), mSeg = new THREE.Matrix4();
  function segment(m, a, b, thickness = 1, taper = false) {
    vDir.subVectors(b, a);
    const len = vDir.length();
    m.visible = len > 1e-3;
    if (!m.visible) return;
    qSeg.setFromUnitVectors(UP, vDir.divideScalar(len));
    const step = len / ROPE_SEG;
    for (let i = 0; i < ROPE_SEG; i++) {
      vP.copy(a).addScaledVector(vDir, step * i);
      const d = vA.copy(vP).addScaledVector(vDir, step / 2).distanceTo(camera.position);
      const r = Math.min(R.ropeMaxRadius, Math.max(R.ropeRadius, d * R.ropeRadiusPerM)) * thickness * (taper ? 1 - 0.65 * i / ROPE_SEG : 1);
      m.setMatrixAt(i, mSeg.compose(vP, qSeg, vScale.set(r, step, r)));
    }
    m.instanceMatrix.needsUpdate = true;
  }
  const splat = new THREE.Mesh(new THREE.PlaneGeometry(R.splatSize, R.splatSize),
    new THREE.MeshBasicMaterial({ map: splatTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
  scene.add(splat);
  let anchorKey = '', flashAge = 1;
  const normal = new THREE.Vector3(), FORWARD = new THREE.Vector3(0, 0, 1);

  // ---- speed lines: thin streaks in camera space, flying past ----
  const nLines = R.speedLineCount;
  const lines = new THREE.InstancedMesh(new THREE.BoxGeometry(0.02, 0.02, 1),
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), nLines);
  lines.frustumCulled = false;
  camera.add(lines);
  const lineZ = Float32Array.from({ length: nLines }, (_, i) => -2 - 26 * hash01(i + 500));

  // ---- stats overlay (?stats) ----
  const statsEl = new URLSearchParams(location.search).has('stats') ? document.body.appendChild(document.createElement('div')) : null;
  if (statsEl) statsEl.style.cssText = 'position:fixed;left:8px;bottom:8px;color:#fff;font:12px monospace;z-index:9';
  let fpsAvg = 60;

  let cam = null;
  const vPos = new THREE.Vector3(), vVel = new THREE.Vector3(), vAnchor = new THREE.Vector3(), vAim = new THREE.Vector3(), vHand = new THREE.Vector3();

  function render(view, dt) {
    const p = view.player;
    const web = view.web ?? null;
    cam = followCamera(p, cam, dt, view.structures);
    const [sx, sy] = shakeOffset(view.shake || 0, view.t);
    camera.position.set(cam.x, cam.y, -cam.z);
    camera.lookAt(cam.lx, cam.ly, -cam.lz);
    camera.translateX(sx); camera.translateY(sy);
    if (Math.abs(camera.fov - cam.fovDeg) > 0.01) { camera.fov = cam.fovDeg; camera.updateProjectionMatrix(); }
    sky.position.copy(camera.position);
    street.position.set(camera.position.x, 0, camera.position.z);

    syncStructures(view.structures, p.pos.z);
    for (let i = 0; i < SKY.length; i++) {
      const s = SKY[i];
      setST(skyline, i, s.x, 0, -wrapZ(s.z, cam.z, R.skylineBack, R.skylineSpan), s.w, s.h, s.d);
    }
    skyline.instanceMatrix.needsUpdate = true;
    syncStreet(cam.z, view.t);

    // hero first: the rope, web and miss line leave its hand
    set3(vPos, p.pos); set3(vVel, p.vel);
    const anchor = p.anchor ? set3(vAnchor, p.anchor) : null;
    const aimAt = web ? set3(vAim, web.to) : view.missLine ? set3(vAim, view.missLine.to) : null;
    hero.update(view.pose, view.t, dt, vPos, vVel, anchor, aimAt, vHand, p.wall || (view.pose === 'wallrun' ? -1 : 0)); // ?debugPose=wallrun: a right wall

    rope.visible = splat.visible = !!anchor;
    const key = p.anchor ? `${p.anchor.x},${p.anchor.y},${p.anchor.z}` : '';
    if (key !== anchorKey) {
      anchorKey = key;
      if (anchor) {
        set3(normal, surfaceNormal(p.anchor, view.structures));
        splat.quaternion.setFromUnitVectors(FORWARD, normal);
        flash.position.copy(anchor).addScaledVector(normal, 0.1);
        flashAge = 0;
      }
    }
    if (anchor) {
      segment(rope, vHand, anchor);
      splat.position.copy(anchor).addScaledVector(normal, 0.035);
    }
    flashAge += dt;
    flash.visible = flashAge < 0.22;
    flash.material.opacity = Math.max(0, 1 - flashAge / 0.22);
    flash.scale.setScalar(0.2 + flashAge * 3.5);
    flight.visible = flightGlow.visible = tip.visible = !!web;
    if (web) {
      set3(vB, web.to);
      const d = vDir.subVectors(vB, vHand).length();
      vB.copy(vHand).addScaledVector(vDir.divideScalar(d || 1), Math.min(web.travelled, d));
      tip.position.copy(vB); tip.scale.setScalar(Math.max(0.11, camera.position.distanceTo(vB) * 0.0025));
      segment(flight, vHand, vB, 1.8, true);
      segment(flightGlow, vHand, vB, 4.5, true);
    }
    miss.visible = !!view.missLine;
    if (view.missLine) {
      segment(miss, vHand, set3(vB, view.missLine.to));
      miss.material.opacity = 0.8 * Math.max(0, 1 - view.missLine.age / CFG.missShowSec);
    }

    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    const k = speedLineK(speed);
    lines.visible = k > 0;
    if (k > 0) {
      lines.material.opacity = 0.8 * k;
      for (let i = 0; i < nLines; i++) {
        lineZ[i] += speed * 1.4 * dt;
        if (lineZ[i] > -1) lineZ[i] -= 28;
        const a = hash01(i + 900) * Math.PI * 2, r = 1.1 + 2.2 * hash01(i + 1300);
        setST(lines, i, Math.cos(a) * r * 1.6, Math.sin(a) * r, lineZ[i], 1, 1, 2 + 4 * k);
      }
      lines.instanceMatrix.needsUpdate = true;
    }

    gl.render(scene, camera);
    if (statsEl) {
      fpsAvg += (1 / Math.max(dt, 1e-3) - fpsAvg) * 0.05;
      statsEl.textContent = `calls ${gl.info.render.calls}  tris ${gl.info.render.triangles}  fps ${fpsAvg.toFixed(0)}`;
      statsEl.dataset.calls = gl.info.render.calls;
      statsEl.dataset.triangles = gl.info.render.triangles;
    }
  }

  function resize(w, h, dpr) {
    gl.setPixelRatio(Math.min(dpr, CFG.maxDpr ?? 2));
    gl.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return { render, resize, info: gl.info };
}
