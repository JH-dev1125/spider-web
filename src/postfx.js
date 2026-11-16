// Speed post-processing: the scene renders into a target, then one full-screen pass adds a radial blur that streams
// out of the focus of travel (the centre, where the hero is, stays sharp), a vignette and a little chromatic
// aberration at speed. Also a modest fov kick (postfx-math.js). ?nofx turns all of it off; a slow GPU turns the pass off.
import { fxTargets, ease, createFrameGuard } from './postfx-math.js';

const TAPS = 12;

const frag = /* glsl */`
uniform sampler2D tScene;
uniform vec2 uFocus;   // uv the motion streams out of
uniform vec2 uHero;    // uv of the hero, who always stays sharp
uniform float uBlur;   // 0..1
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 d = vUv - uFocus;
  float r = length(d * vec2(uAspect, 1.0));
  float m = uBlur * smoothstep(0.12, 0.75, r) // sharp middle, smeared edges
    * smoothstep(0.1, 0.3, length((vUv - uHero) * vec2(uAspect, 1.0)));
  vec2 ca = d * 0.006 * uBlur;
  vec3 c = vec3(texture2D(tScene, vUv + ca).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - ca).b);
  if (m > 0.002) {
    vec2 stp = d * m * 0.16 / float(${TAPS - 1});
    float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453); // dither hides the tap steps
    for (int i = 1; i < ${TAPS}; i++) c += texture2D(tScene, vUv - stp * (float(i) - j)).rgb;
    c /= float(${TAPS});
  }
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  c *= 1.0 - (0.22 + 0.18 * uBlur) * smoothstep(0.35, 1.05, length(q)); // vignette, deeper at speed
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export function createPostFX(THREE, renderer, scene, camera) {
  const off = new URLSearchParams(location.search).has('nofx');
  const msaa = renderer.getContextAttributes().antialias ? 4 : 0; // the canvas's own AA does not reach a target
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: msaa, colorSpace: THREE.SRGBColorSpace });
  const mat = new THREE.ShaderMaterial({
    uniforms: { tScene: { value: target.texture }, uFocus: { value: new THREE.Vector2(0.5, 0.5) }, uHero: { value: new THREE.Vector2(0.5, 0.5) }, uBlur: { value: 0 }, uAspect: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: frag,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2(), v = new THREE.Vector3(), fwd = new THREE.Vector3();
  const guard = createFrameGuard();
  renderer.info.autoReset = false; // two renders a frame: ?stats should count both
  let enabled = !off, blur = 0, kick = 0, fx = 0.5, fy = 0.5, last = 0;

  function resize(w, h, dpr) { target.setSize(Math.round(w * dpr), Math.round(h * dpr)); }

  function render(view, dt) {
    renderer.info.reset();
    if (off) { renderer.render(scene, camera); return; }
    const now = performance.now() / 1000;
    if (last && enabled && !guard.tick(now - last)) { enabled = false; console.warn('postfx: frame time over 20 ms for 2 s, blur off'); }
    last = now;

    const vel = view.player.vel, t = fxTargets(vel);
    blur = ease(blur, t.blur, dt);
    kick = ease(kick, t.fov, dt);
    // focus of expansion: where the velocity points on screen (game z is three's -z)
    v.set(vel.x, vel.y, -vel.z);
    camera.getWorldDirection(fwd);
    let tx = 0.5, ty = 0.5;
    if (v.dot(fwd) > 0.3 * v.length()) {
      v.add(camera.position).project(camera);
      tx = 0.5 + 0.5 * Math.max(-1, Math.min(1, v.x)); ty = 0.5 + 0.5 * Math.max(-1, Math.min(1, v.y));
    }
    const a = 1 - Math.exp(-4 * dt);
    fx += (tx - fx) * a; fy += (ty - fy) * a;

    const fov = camera.fov;
    if (kick > 0.01) { camera.fov = fov + kick; camera.updateProjectionMatrix(); }
    if (!enabled) renderer.render(scene, camera);
    else {
      renderer.getDrawingBufferSize(size);
      if (size.x !== target.width || size.y !== target.height) target.setSize(size.x, size.y); // render.js's resize stays as it was
      mat.uniforms.uBlur.value = blur;
      mat.uniforms.uFocus.value.set(fx, fy);
      const h = view.player.pos;
      v.set(h.x, h.y, -h.z).project(camera); // in front of the camera: |z| < 1
      mat.uniforms.uHero.value.set(Math.abs(v.z) < 1 ? 0.5 + 0.5 * v.x : -9, 0.5 + 0.5 * v.y);
      mat.uniforms.uAspect.value = size.x / size.y;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(quad, ortho);
    }
    if (kick > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  return { render, resize, setEnabled(on) { enabled = !off && on; } };
}
