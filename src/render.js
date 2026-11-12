// three.js renderer. The only module that imports 'three' (import map in index.html).
//
// Coordinates: world (x right, y up, z forward) maps to three.js as (x, y, -z). three's camera looks down -z,
// so "forward" stays into the screen and +x stays on the right. All world -> three conversion goes through
// set3() / the -z writes below.
import * as THREE from 'three';
import { CFG } from './config.js';
import { hash01 } from './world.js';
import { followCamera, shakeOffset, speedLineK, wrapZ } from './render-math.js';
import { createHero } from './character.js';

const R = CFG.render;
const C = CFG.colors;
const W = CFG.corridorHalfWidth;
const MAX_BUILDINGS = 256;
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
          vec3 glass = mix(tint * 0.18, litColor * (0.7 + 0.6 * fract(vInfo.a * 7.0)), t.g);
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

  // ---- buildings: corridor (rebuilt when view.buildings changes) + skyline (wrapped every frame) ----
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
  const corridor = instanced(box, facade, MAX_BUILDINGS);
  const corridorInfo = withInfo(corridor, MAX_BUILDINGS);
  const skyline = instanced(box, facade, R.skylineCount);
  const skylineInfo = withInfo(skyline, R.skylineCount);
  const cornice = instanced(box, new THREE.MeshLambertMaterial({ color: C.endFace }), MAX_BUILDINGS);
  const tanks = instanced(new THREE.CylinderGeometry(1, 1, 1, 10).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: '#3a3048' }), MAX_BUILDINGS * 2);
  const antennas = instanced(box, new THREE.MeshLambertMaterial({ color: '#2a2a36' }), MAX_BUILDINGS);
  const redLights = instanced(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshBasicMaterial({ color: '#ff4a4a' }), MAX_BUILDINGS);

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

  let sig = '';
  function syncBuildings(list) {
    const s = list.length && `${list.length}|${list[0].z0}|${list[list.length - 1].z0}`;
    if (s === sig) return;
    sig = s;
    let nt = 0, na = 0;
    const n = Math.min(list.length, MAX_BUILDINGS);
    for (let i = 0; i < n; i++) {
      const b = list[i];
      const key = Math.round(b.z0 * 16) * 2 + (b.side === 'L' ? 0 : 1); // stable per building: side + z0
      const h = (k) => hash01(key * 13 + k);
      const sd = b.side === 'L' ? -1 : 1;
      const depth = R.depthMin + (R.depthMax - R.depthMin) * h(0);
      const len = b.z1 - b.z0, cx = sd * (W + depth / 2), cz = -(b.z0 + b.z1) / 2;
      setST(corridor, i, cx, 0, cz, depth, b.h, len);
      writeInfo(corridorInfo, i, tints[Math.floor(h(1) * tints.length)], Math.floor(h(2) * 3) + h(3) * 0.99);
      setST(cornice, i, cx, b.h, cz, depth + 0.6, R.corniceH, len + 0.6);
      for (let k = 0; k < 2; k++) if (h(4 + k) < R.tankChance && nt < tanks.instanceMatrix.count) {
        const r = 1.4 + h(6 + k);
        setST(tanks, nt++, cx + (h(8 + k) - 0.5) * (depth - 6), b.h + R.corniceH, cz + (h(10 + k) - 0.5) * (len - 6), r, 3 + 2 * h(12 + k), r);
      }
      if (h(14) < R.antennaChance) {
        const ax = cx + (h(15) - 0.5) * depth * 0.5, az = cz + (h(16) - 0.5) * len * 0.5, ah = R.antennaH * (0.6 + 0.8 * h(17));
        setST(antennas, na, ax, b.h, az, 0.25, ah, 0.25);
        setST(redLights, na++, ax, b.h + ah, az, 0.35, 0.35, 0.35);
      }
    }
    corridor.count = cornice.count = n;
    tanks.count = nt;
    antennas.count = redLights.count = na;
    for (const m of [corridor, cornice, tanks, antennas, redLights]) m.instanceMatrix.needsUpdate = true;
    corridorInfo.needsUpdate = true;
  }

  // ---- street lights + cars: one instanced batch of glowing boxes ----
  const lightsPerX = Math.ceil(R.streetSpan / R.streetLightSpacing);
  const carsPerLane = Math.ceil(R.streetSpan / R.carSpacing);
  const nGlow = R.streetLightXs.length * lightsPerX + R.carLanes.length * carsPerLane;
  const glow = instanced(box, new THREE.MeshBasicMaterial(), nGlow);
  glow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nGlow * 3), 3);
  { // colours are fixed per slot
    let i = 0;
    const lamp = new THREE.Color(C.streetLight), head = new THREE.Color(C.carHead), tail = new THREE.Color(C.carTail);
    for (let k = 0; k < R.streetLightXs.length * lightsPerX; k++) glow.setColorAt(i++, lamp);
    for (const x of R.carLanes) for (let k = 0; k < carsPerLane; k++) glow.setColorAt(i++, x > 0 ? tail : head);
  }
  glow.count = nGlow;
  function syncStreet(camZ, t) {
    let i = 0;
    const back = R.streetSpan * 0.3;
    for (const x of R.streetLightXs) for (let k = 0; k < lightsPerX; k++) {
      const z = wrapZ(k * R.streetLightSpacing, camZ, back, R.streetSpan);
      setST(glow, i++, x, R.streetLightY, -z, 0.5, 0.25, 0.5);
    }
    for (let li = 0; li < R.carLanes.length; li++) {
      const x = R.carLanes[li], dir = x > 0 ? 1 : -1; // right lanes drive away (tail lights), left come at you
      for (let k = 0; k < carsPerLane; k++) {
        const gone = hash01(k * R.carLanes.length + li) < R.carGapChance;
        const z = wrapZ(k * R.carSpacing + dir * t * R.carSpeed, camZ, back, R.streetSpan);
        setST(glow, i++, x, 0.7, -z, gone ? 0 : 1.7, gone ? 0 : 0.35, gone ? 0 : 0.5);
      }
    }
    glow.instanceMatrix.needsUpdate = true;
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
  const rope = strand(1), flight = strand(1), miss = strand(0.8);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vDir = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  const vP = new THREE.Vector3(), vScale = new THREE.Vector3(), qSeg = new THREE.Quaternion(), mSeg = new THREE.Matrix4();
  function segment(m, a, b) {
    vDir.subVectors(b, a);
    const len = vDir.length();
    m.visible = len > 1e-3;
    if (!m.visible) return;
    qSeg.setFromUnitVectors(UP, vDir.divideScalar(len));
    const step = len / ROPE_SEG;
    for (let i = 0; i < ROPE_SEG; i++) {
      vP.copy(a).addScaledVector(vDir, step * i);
      const d = vA.copy(vP).addScaledVector(vDir, step / 2).distanceTo(camera.position);
      const r = Math.min(R.ropeMaxRadius, Math.max(R.ropeRadius, d * R.ropeRadiusPerM));
      m.setMatrixAt(i, mSeg.compose(vP, qSeg, vScale.set(r, step, r)));
    }
    m.instanceMatrix.needsUpdate = true;
  }
  const splat = new THREE.Mesh(new THREE.PlaneGeometry(R.splatSize, R.splatSize),
    new THREE.MeshBasicMaterial({ map: splatTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
  scene.add(splat);

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
    cam = followCamera(p, cam, dt);
    const [sx, sy] = shakeOffset(view.shake || 0, view.t);
    camera.position.set(cam.x, cam.y, -cam.z);
    camera.lookAt(cam.lx, cam.ly, -cam.lz);
    camera.translateX(sx); camera.translateY(sy);
    if (Math.abs(camera.fov - cam.fovDeg) > 0.01) { camera.fov = cam.fovDeg; camera.updateProjectionMatrix(); }
    sky.position.copy(camera.position);
    street.position.set(camera.position.x, 0, camera.position.z);

    syncBuildings(view.buildings);
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
    hero.update(view.pose, view.t, dt, vPos, vVel, anchor, aimAt, vHand);

    rope.visible = splat.visible = !!anchor;
    if (anchor) {
      segment(rope, vHand, anchor);
      splat.position.copy(anchor);
      const onWall = Math.abs(Math.abs(p.anchor.x) - W) < 0.5; // inner face, else a roof
      if (onWall) splat.lookAt(0, anchor.y, anchor.z); else splat.lookAt(anchor.x, anchor.y + 1, anchor.z);
      splat.translateZ(0.05);
    }
    flight.visible = !!web;
    if (web) {
      set3(vB, web.to);
      const d = vDir.subVectors(vB, vHand).length();
      vB.copy(vHand).addScaledVector(vDir.divideScalar(d || 1), Math.min(web.travelled, d));
      segment(flight, vHand, vB);
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
