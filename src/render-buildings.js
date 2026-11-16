// Draws what archetypes.js adds on top of plain tower blocks, and the city's lights:
//   kinds slab, column, spire, roof, clock, sign, balcony, tank (render.js skips them: decor.owns(kind));
//   facade colour/style per archetype (brick, stone, glass) for the tower blocks render.js draws;
//   lit-window variety patched into render.js's facade shader (warm / cool rooms with depth, a few flickering);
//   additive glow halos (neon, billboards, clock dials, terrace lamps, street lamps) and blinking red aircraft lights.
// One instanced batch per geometry/material, rebuilt only when boxes enter or leave. No postprocessing.
// World (x, y, z) -> three.js (x, y, -z), as in render.js.
import { CFG } from './config.js';
import { hash01 } from './world.js';
import { wrapZ } from './render-math.js';

const R = CFG.render;
export const DECOR_KINDS = new Set(['slab', 'column', 'spire', 'roof', 'clock', 'sign', 'balcony', 'tank']);

const STYLE = { clock: 0, brownstone: 0, walkup: 0, warehouse: 0, deco: 1, empire: 1, gothic: 1, pyramid: 1, terrace: 1, glass: 2, billboard: 2 };
const TINT = {
  clock: [[150, 78, 58], [132, 70, 52]], brownstone: [[122, 74, 58], [138, 84, 64]], walkup: [[146, 86, 64], [118, 92, 78]],
  warehouse: [[128, 76, 60], [110, 84, 70]], deco: [[196, 188, 172], [182, 172, 156]], empire: [[170, 160, 142], [158, 150, 136]],
  gothic: [[136, 128, 118], [150, 142, 128]], pyramid: [[150, 150, 156], [128, 134, 146]], terrace: [[176, 172, 164], [142, 148, 152]],
  glass: [[70, 104, 134], [58, 92, 122]], billboard: [[84, 96, 120], [96, 106, 122]],
};
const NEON = ['#ff3d8b', '#3df2ff', '#ffb02e', '#9d5cff'];
const ADS = [['ZIPLINE COLA', 'taste the swing', '#d0202e', '#fff1d6'], ['NOVA PHONES', 'call the sky', '#14213d', '#7fe0ff'],
  ['HARBOR BANK', 'since 1891', '#0f5132', '#f2e3b3'], ['SKYLINE TOURS', 'see it from the top', '#f2b134', '#1b1b2f']];
const NEON_WORDS = ['HOTEL', 'BAR', 'DINER', 'JAZZ'];
const BARS = ['OPEN 24', 'PIZZA', 'LIVE MUSIC', 'NOODLES'];
const WALL = [['WEB RUNNER', 'now swinging', '#1d2f8a', '#ffd54a'], ['METRO NEWS', 'all day', '#f4f1ea', '#c8102e']];

// atlas rects in a 1024 px canvas: [x, y, w, h]
const RECT = {
  ad: (i) => [0, i * 192, 512, 192],
  neon: (i) => [512 + i * 128, 0, 128, 416],
  bar: (i) => [512, 448 + i * 80, 320, 80],
  wall: (i) => [i * 512, 768, 512, 256],
};

function atlas(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 1024);
  const font = (px) => `900 ${px}px system-ui, "Segoe UI", sans-serif`;
  const fit = (text, px, w) => { g.font = font(px); const k = Math.min(1, w / g.measureText(text).width); g.font = font(px * k); };
  ADS.forEach(([title, tag, bg, fg], i) => {
    const [x, y, w, h] = RECT.ad(i);
    const gr = g.createLinearGradient(x, y, x + w, y + h); gr.addColorStop(0, bg); gr.addColorStop(1, '#000');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    fit(title, 74, w - 40); g.fillText(title, x + w / 2, y + h * 0.42);
    g.font = font(28); g.globalAlpha = 0.8; g.fillText(tag, x + w / 2, y + h * 0.78); g.globalAlpha = 1;
    g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(x + 8, y + 8, w - 16, h - 16);
  });
  const glowText = (text, cx, cy, color) => {
    g.shadowColor = color; g.fillStyle = color;
    for (const blur of [26, 12]) { g.shadowBlur = blur; g.fillText(text, cx, cy); }
    g.shadowBlur = 0; g.fillStyle = '#fff'; g.globalAlpha = 0.7; g.fillText(text, cx, cy); g.globalAlpha = 1;
  };
  NEON_WORDS.forEach((word, i) => {
    const [x, y, w, h] = RECT.neon(i);
    g.fillStyle = '#0d0710'; g.fillRect(x, y, w, h);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(Math.min(76, (h - 30) / word.length));
    [...word].forEach((ch, k) => glowText(ch, x + w / 2, y + 22 + (k + 0.5) * (h - 44) / word.length, NEON[i]));
    g.strokeStyle = NEON[(i + 1) % 4]; g.lineWidth = 4; g.shadowColor = g.strokeStyle; g.shadowBlur = 10;
    g.strokeRect(x + 8, y + 8, w - 16, h - 16); g.shadowBlur = 0;
  });
  BARS.forEach((word, i) => {
    const [x, y, w, h] = RECT.bar(i);
    g.fillStyle = '#0d0710'; g.fillRect(x, y, w, h);
    g.textAlign = 'center'; g.textBaseline = 'middle'; fit(word, 54, w - 30);
    glowText(word, x + w / 2, y + h / 2, NEON[(i + 2) % 4]);
  });
  WALL.forEach(([title, tag, bg, fg], i) => {
    const [x, y, w, h] = RECT.wall(i);
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    fit(title, 88, w - 50); g.fillText(title, x + w / 2, y + h * 0.42);
    g.font = font(34); g.fillText(tag, x + w / 2, y + h * 0.75);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function dialTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  g.fillStyle = '#2a1d16'; g.fillRect(-128, -128, 256, 256);
  const gr = g.createRadialGradient(0, 0, 10, 0, 0, 118); gr.addColorStop(0, '#fff6dc'); gr.addColorStop(1, '#f1d79a');
  g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 116, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#3a2a1e'; g.lineWidth = 8; g.stroke();
  g.fillStyle = '#2b2118';
  for (let i = 0; i < 12; i++) {
    g.save(); g.rotate((i / 12) * Math.PI * 2); g.fillRect(-3, -108, 6, i % 3 ? 14 : 24); g.restore();
  }
  const hand = (a, len, w) => { g.save(); g.rotate(a); g.fillRect(-w / 2, -len, w, len + 12); g.restore(); };
  hand(-0.95, 62, 9); hand(0.72, 92, 6); // ten past ten
  g.beginPath(); g.arc(0, 0, 8, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function poolTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Camera-facing additive glow quads, fading with the scene's exp2 fog. uniform gain dims or blinks a whole batch.
function haloMaterial(THREE) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { gain: { value: 1 } }]),
    vertexShader: `
      varying vec2 vUv; varying vec3 vCol;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mvPosition.xy += position.xy * length(instanceMatrix[0].xyz);
        vUv = uv; vCol = instanceColor;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float gain; varying vec2 vUv; varying vec3 vCol;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      #include <fog_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float d = length(vUv - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 2.4) + 0.6 * pow(max(0.0, 1.0 - d * 3.0), 2.0);
        #ifdef USE_FOG
          a *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        #endif
        gl_FragColor = vec4(vCol * a * gain, 1.0);
      }`,
  });
}

// Lit windows: warm and cool rooms, a back wall offset by the view angle (interior depth), a few flickering.
// Inserted after the facade shader's glass mix; if render.js changes that line the patch is skipped (plain windows).
const FACADE_ANCHOR = 'col = mix(tint * light, glass, t.r);';
const facadeLights = (cols, rows) => `
          {
            vec2 cells = vec2(${cols.toFixed(1)}, ${rows.toFixed(1)});
            vec2 cid = floor(uv * cells), f = fract(uv * cells);
            float hs = fract(sin(dot(cid + floor(vInfo.a * 13.0), vec2(12.9898, 78.233))) * 43758.5453);
            vec3 room = mix(litColor, vec3(0.72, 0.86, 1.0), step(0.7, hs)) * (0.75 + 0.5 * fract(hs * 7.0));
            vec3 vd = normalize(vW - cameraPosition);
            vec2 q = f - 0.5 + (abs(n.x) > 0.5 ? vec2(-vd.z * sign(n.x), vd.y) : vec2(vd.x * sign(n.z), vd.y)) * 0.32;
            float inner = smoothstep(0.55, 0.22, max(abs(q.x), abs(q.y)));
            float depth = 0.3 + 0.9 * inner * (0.7 + 0.3 * smoothstep(0.25, -0.25, q.y));
            float flick = hs > 0.982 ? 0.25 + 0.75 * step(0.4, fract(sin(floor(uTime * 9.0) + hs * 91.0) * 43758.5)) : 1.0;
            col = mix(col, mix(col, room * depth * flick * 1.15, t.r), step(0.01, t.g));
          }`;

export function createBuildingDecor(THREE, scene, facade) {
  const srgb = ([r, g, b]) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  const tints = Object.fromEntries(Object.entries(TINT).map(([k, v]) => [k, v.map(srgb)]));

  if (facade.fragmentShader.includes(FACADE_ANCHOR)) {
    facade.uniforms.uTime = { value: 0 };
    facade.fragmentShader = facade.fragmentShader
      .replace('uniform vec2 cell;', 'uniform vec2 cell; uniform float uTime;')
      .replace(FACADE_ANCHOR, FACADE_ANCHOR + facadeLights(R.texCols, R.texRows));
    facade.needsUpdate = true;
  } else console.warn('render-buildings: facade shader changed, window lights not patched');

  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const r2 = Math.SQRT1_2;
  const square = (top) => new THREE.CylinderGeometry(r2 * top, r2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
  const plane = new THREE.PlaneGeometry(1, 1);
  const ads = new THREE.MeshBasicMaterial({ map: atlas(THREE), color: new THREE.Color(0.92, 0.92, 0.92) });
  ads.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'attribute vec4 aRect;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = uv * aRect.zw + aRect.xy;');
  };
  const steelMat = new THREE.MeshPhongMaterial({ color: '#c8ccd4', shininess: 80, specular: '#ffffff' });
  const pool = new THREE.MeshBasicMaterial({ map: poolTexture(THREE), color: new THREE.Color('#ffc477'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -4 });
  const BATCH = {
    stone: [box, new THREE.MeshLambertMaterial({ color: '#ffffff' })], // instance colour
    metal: [box, new THREE.MeshLambertMaterial({ color: '#2a2e36' })],
    taper: [square(0.55), steelMat],
    needle: [new THREE.ConeGeometry(0.5, 1, 8).translate(0, 0.5, 0), steelMat],
    pyramid: [square(0), new THREE.MeshLambertMaterial({ color: '#ffffff' })],
    tank: [new THREE.CylinderGeometry(0.5, 0.5, 1, 14).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: '#6b4a36' })],
    tankRoof: [new THREE.ConeGeometry(0.55, 1, 14).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: '#3b3029' })],
    dial: [plane, new THREE.MeshBasicMaterial({ map: dialTexture(THREE) })],
    ads: [plane, ads],
    halo: [plane, haloMaterial(THREE)],
    blink: [plane, haloMaterial(THREE)],
  };
  // every batch has an instance colour (white by default), so the halo shader can always read instanceColor
  const batch = (geo, mat, cap) => {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    m.frustumCulled = false; m.count = 0;
    scene.add(m);
    return m;
  };
  const meshes = {};
  for (const [name, [geo, mat]] of Object.entries(BATCH)) {
    meshes[name] = batch(name === 'ads' ? geo.clone() : geo, mat, 16);
    if (name === 'ads') meshes.ads.geometry.setAttribute('aRect', new THREE.InstancedBufferAttribute(new Float32Array(16 * 4), 4));
  }

  // ---- describe one box -> parts {g: batch, m: Matrix4, c?: Color, r?: rect} ----
  const Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), DIR = new THREE.Vector3();
  const C = (hex) => new THREE.Color(hex);
  const ROT = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': Math.PI, '-z': 0 };
  const NORMAL = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, -1], '-z': [0, 1] }; // three.js x, z

  function describe(s) {
    const parts = [];
    const { min: a, max: b } = s;
    const cx = (a.x + b.x) / 2, cz = -(a.z + b.z) / 2, dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const h = (k) => hash01(s.id.length * 7919 + [...s.id].reduce((v, ch) => v * 31 + ch.charCodeAt(0), 0) % 1e6 + k);
    const put = (g, x, y, z, sx, sy, sz, rotY = 0, c, r) => {
      Q.setFromEuler(E.set(0, rotY, 0));
      parts.push({ g, m: new THREE.Matrix4().compose(P.set(x, y, z), Q, S.set(sx, sy, sz)), c, r });
    };
    const beam = (g, x0, y0, z0, x1, y1, z1, w) => {
      DIR.set(x1 - x0, y1 - y0, z1 - z0); const len = DIR.length();
      Q.setFromUnitVectors(UP, DIR.divideScalar(len));
      parts.push({ g, m: new THREE.Matrix4().compose(P.set(x0, y0, z0), Q, S.set(w, len, w)) });
    };
    const glow = (g, x, y, z, size, color) => put(g, x, y, z, size, size, size, 0, C(color));
    const f = s.facing ?? '+x', [nx, nz] = NORMAL[f], rot = ROT[f];
    const along = nx ? [0, 1] : [1, 0], width = nx ? dz : dx;
    // the street-side face of the box, in three.js coordinates
    const fx = nx > 0 ? b.x : nx < 0 ? a.x : cx, fz = nz > 0 ? -a.z : nz < 0 ? -b.z : cz;
    const onFace = (out, u, y) => [fx + nx * out + along[0] * u, y, fz + nz * out + along[1] * u];
    const concrete = C('#b9b4aa').lerp(C('#8e8d8a'), h(1));

    if (s.kind === 'slab') {
      put('stone', cx, a.y, cz, dx, dy, dz, 0, concrete);
      if (s.id.endsWith('floor')) { // a railing along the open face, and warm lamps hanging in the band
        const [x, , z] = onFace(-0.1, 0, b.y);
        put('metal', x, b.y + 1.05, z, nx ? 0.08 : width, 0.07, nx ? width : 0.08);
        for (let u = -width / 2 + 3; u < width / 2 - 2; u += 6) {
          const [lx, , lz] = onFace(-2.5, u, 0);
          glow('halo', lx, b.y + 4.6, lz, 2.2, h(2) < 0.5 ? '#ffb468' : '#ffd9a0');
        }
      }
    } else if (s.kind === 'column') {
      put('stone', cx, a.y, cz, dx, dy, dz, 0, concrete.clone().multiplyScalar(0.92));
    } else if (s.kind === 'balcony') {
      if (s.shape === 'fire') { // black steel grating, a rail, a ladder down to the one below
        put('metal', cx, a.y, cz, dx, 0.12, dz);
        const [x, , z] = onFace(0, 0, 0);
        put('metal', x, a.y + 1.0, z, nx ? 0.06 : width, 0.06, nx ? width : 0.06);
        for (const u of [-width / 2 + 0.05, width / 2 - 0.05]) { const [px, , pz] = onFace(0, u, 0); put('metal', px, a.y, pz, 0.06, 1.0, 0.06); }
        if (a.y > 4) {
          const [x0, , z0] = onFace(-0.6, -width / 2 + 0.6, 0), [x1, , z1] = onFace(-0.6, width / 2 - 0.8, 0);
          beam('metal', x0, a.y - 2.88, z0, x1, a.y + 0.06, z1, 0.12);
        }
      } else { // concrete slab, dark steel and glass rail
        put('stone', cx, a.y, cz, dx, 0.3, dz, 0, concrete);
        const [x, , z] = onFace(0, 0, 0);
        put('metal', x, a.y + 0.3, z, nx ? 0.05 : width, dy - 0.3, nx ? width : 0.05);
      }
    } else if (s.kind === 'spire') {
      const top = [cx, b.y, cz];
      if (s.shape === 'taper') {
        put('taper', cx, a.y, cz, dx, dy, dz);
        for (let i = 0; i < 4; i++) { // lit triangular windows on the crown: small glows on each side
          const [gx, , gz] = [cx + [1, -1, 0, 0][i] * dx * 0.42, 0, cz + [0, 0, 1, -1][i] * dz * 0.42];
          glow('halo', gx, a.y + dy * 0.4, gz, Math.min(dx, dz) * 0.5, '#fff1c4');
        }
      } else if (s.shape === 'mast') {
        put('metal', cx, a.y, cz, dx * 0.45, dy, dz * 0.45);
        for (let y = a.y + 3; y < b.y - 1; y += 3.5) put('metal', cx, y, cz, dx * 1.6, 0.12, dz * 1.6);
      } else put('needle', cx, a.y, cz, dx, dy, dz);
      if (s.light) { put('metal', ...top, 0.25, 0.25, 0.25); glow('blink', top[0], top[1] + 0.2, top[2], 3.2, '#ff2a1a'); }
    } else if (s.kind === 'roof') {
      const copper = s.arch === 'clock' ? C('#5a3a30') : h(3) < 0.6 ? C('#3e9a78') : C('#56606e'); // verdigris or slate
      put('pyramid', cx, a.y, cz, dx, dy, dz, 0, copper);
      if (s.light) glow('blink', cx, b.y + 0.3, cz, 3.2, '#ff2a1a');
    } else if (s.kind === 'clock') {
      put('stone', cx, a.y, cz, dx, dy, dz, 0, C('#cbbd9e'));
      const [x, , z] = onFace(R.decalLift, 0, 0);
      put('dial', x, (a.y + b.y) / 2, z, width * 0.92, dy * 0.92, 1, rot);
      const [hx, , hz] = onFace(0.6, 0, 0);
      glow('halo', hx, (a.y + b.y) / 2, hz, width * 1.9, '#ffcf80');
    } else if (s.kind === 'sign') {
      const i = Math.floor(h(4) * 4);
      const [x, , z] = onFace(R.decalLift, 0, 0), y = (a.y + b.y) / 2;
      put('metal', cx, a.y, cz, dx, dy, dz);
      if (s.shape === 'billboard') {
        put('ads', x, y, z, width, dy, 1, rot, undefined, RECT.ad(i));
        for (const u of [-width * 0.35, 0, width * 0.35]) { // posts down to the roof, uplights on the catwalk
          const [px, , pz] = onFace(-0.5, u, 0);
          put('metal', px, a.y - 3, pz, 0.3, 3, 0.3);
          const [lx, , lz] = onFace(0.6, u, 0);
          glow('halo', lx, a.y + 0.2, lz, 3, '#fff2d0');
        }
        const [cwx, , cwz] = onFace(0.4, 0, 0);
        put('metal', cwx, a.y - 0.1, cwz, nx ? 1 : width, 0.12, nx ? width : 1);
      } else if (s.shape === 'wallad') {
        put('ads', x, y, z, width * 0.96, dy * 0.94, 1, rot, undefined, RECT.wall(i % 2));
        const [lx, , lz] = onFace(1.5, 0, 0);
        glow('halo', lx, y, lz, Math.max(width, dy) * 1.2, i % 2 ? '#ffe0b0' : '#9fb8ff');
      } else { // neon: vertical blade or a bar over a shop front
        const tall = dy > width;
        put('ads', x, y, z, width, dy, 1, rot, undefined, tall ? RECT.neon(i) : RECT.bar(i));
        const [lx, , lz] = onFace(1, 0, 0);
        glow('halo', lx, y, lz, Math.max(width, dy) * 1.5, tall ? NEON[i] : NEON[(i + 2) % 4]);
      }
    } else if (s.kind === 'tank') { // legs, a wooden tank with steel hoops, a conical lid
      const r = Math.min(dx, dz);
      for (const ox of [-0.32, 0.32]) for (const oz of [-0.32, 0.32]) put('metal', cx + ox * r, a.y, cz + oz * r, 0.2, 2.6, 0.2);
      put('metal', cx, a.y + 2.5, cz, r * 0.9, 0.15, r * 0.9);
      put('tank', cx, a.y + 2.6, cz, r * 0.9, 4, r * 0.9);
      for (const y of [3.4, 4.6, 5.8]) put('metal', cx, a.y + y, cz, r * 0.93, 0.08, r * 0.93);
      put('tankRoof', cx, a.y + 6.6, cz, r * 0.95, 0.9, r * 0.95);
    }
    return parts;
  }

  // ---- batches: rebuilt when boxes enter or leave ----
  const records = new Map();
  let staticHalos = 0;
  const lightsPerX = Math.ceil(R.streetSpan / R.streetLightSpacing), nLamps = R.streetLightXs.length * lightsPerX;
  const lampColor = new THREE.Color('#ffc477');
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), pool, nLamps);
  pools.frustumCulled = false;
  scene.add(pools);

  function ensure(name, n) {
    let m = meshes[name];
    if (n <= m.instanceMatrix.count) return m;
    const cap = 2 ** Math.ceil(Math.log2(n));
    scene.remove(m); m.dispose();
    const geo = m.geometry;
    if (name === 'ads') geo.setAttribute('aRect', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
    return (meshes[name] = batch(geo, m.material, cap));
  }

  function sync(list) {
    const live = new Set();
    let changed = false;
    for (const s of list) {
      if (!DECOR_KINDS.has(s.kind)) continue;
      live.add(s.id);
      if (!records.has(s.id)) { records.set(s.id, describe(s)); changed = true; }
    }
    for (const id of records.keys()) if (!live.has(id)) { records.delete(id); changed = true; }
    if (!changed) return;
    const all = Object.fromEntries(Object.keys(BATCH).map((k) => [k, []]));
    for (const parts of records.values()) for (const p of parts) all[p.g].push(p);
    staticHalos = all.halo.length;
    for (const [name, parts] of Object.entries(all)) {
      const m = ensure(name, parts.length + (name === 'halo' ? nLamps : 0));
      parts.forEach((p, i) => {
        m.setMatrixAt(i, p.m);
        if (p.c) m.setColorAt(i, p.c);
        if (p.r) m.geometry.attributes.aRect.setXYZW(i, p.r[0] / 1024, 1 - (p.r[1] + p.r[3]) / 1024, p.r[2] / 1024, p.r[3] / 1024);
      });
      m.count = parts.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      if (name === 'ads') m.geometry.attributes.aRect.needsUpdate = true;
    }
  }

  // street lamps: a warm glow at each lamp head (render.js draws the poles) and a light pool on the street
  const M = new THREE.Matrix4();
  function tick(t, camZ) {
    if (facade.uniforms.uTime) facade.uniforms.uTime.value = t;
    meshes.blink.material.uniforms.gain.value = 0.15 + 1.1 * Math.max(0, Math.sin(t * 2.6)) ** 6;
    const halo = ensure('halo', staticHalos + nLamps), back = R.streetSpan * 0.3;
    let i = 0;
    for (const x of R.streetLightXs) for (let k = 0; k < lightsPerX; k++) {
      const z = -wrapZ(k * R.streetLightSpacing, camZ, back, R.streetSpan);
      halo.setMatrixAt(staticHalos + i, M.makeScale(2.6, 2.6, 2.6).setPosition(x, R.streetLightY + 0.1, z));
      halo.setColorAt(staticHalos + i, lampColor);
      pools.setMatrixAt(i++, M.makeScale(9, 1, 9).setPosition(x - Math.sign(x) * 1.5, 0.03, z));
    }
    halo.count = staticHalos + i;
    halo.instanceMatrix.needsUpdate = true;
    halo.instanceColor.needsUpdate = true;
    pools.instanceMatrix.needsUpdate = true;
  }

  // archetype facade for render.js's tower blocks: {color, style} (style integer = window texture, + seed)
  const facadeOf = (s) => {
    if (!s.arch || !(s.arch in STYLE)) return {};
    const pre = s.id.split(':')[0];
    const k = hash01([...pre].reduce((v, ch) => v * 31 + ch.charCodeAt(0), 7) % 1e6);
    const list = tints[s.arch];
    return { color: list[Math.floor(k * list.length)], style: STYLE[s.arch] + hash01(k * 1e6) * 0.99 };
  };

  return { owns: (kind) => DECOR_KINDS.has(kind), sync, tick, facade: facadeOf };
}

