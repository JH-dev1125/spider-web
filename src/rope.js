// Rope wrapping: an attached rope bends around the structure edges it swings into, and straightens again.
// p.ropePoints is the stack of bends, ordered from the anchor end toward the hero: the rope runs
// p.anchor -> ropePoints[0] -> ... -> ropePoints[last] -> hero, and the physics rope (ph.anchor body) pivots on the
// last one. Each point is {x, y, z, n}: n = the bend's turning axis (unit cross(bend - previous, hero - bend)) when it
// was made; the rope unwraps once the hero swings back across it (that cross product changes sign).
// p.ropeLen is the free length (pivot to hero); free + the wrapped segments = the whole rope.
import * as CANNON from '../vendor/cannon-es.js';
import { CFG } from './config.js';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const plain = (v) => ({ x: v.x, y: v.y, z: v.z });
const AX = ['x', 'y', 'z'];

const ray = new CANNON.RaycastResult(), from3 = new CANNON.Vec3(), to3 = new CANNON.Vec3();
// The structure box that cuts the straight rope from a to b (touching it at b, the pivot, does not count), or null.
export function blocker(ph, a, b, mask) {
  const d = len(sub(b, a));
  if (d < 0.2) return null;
  ray.reset();
  ph.world.raycastClosest(from3.set(a.x, a.y, a.z), to3.set(b.x, b.y, b.z), { skipBackfaces: true, collisionFilterMask: mask }, ray);
  return ray.hasHit && ray.distance < d - 0.1 && ray.body.structure ? ray.body.structure : null;
}

// The 12 edges of box s: free axis k from min to max; the other two axes i, j fixed at min (sign -1) or max (+1).
function edges(s) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const i = AX[(k + 1) % 3], j = AX[(k + 2) % 3], K = AX[k];
    for (const si of [-1, 1]) for (const sj of [-1, 1]) {
      const p0 = { x: 0, y: 0, z: 0 };
      p0[i] = si > 0 ? s.max[i] : s.min[i]; p0[j] = sj > 0 ? s.max[j] : s.min[j]; p0[K] = s.min[K];
      const p1 = { ...p0 }; p1[K] = s.max[K];
      out.push({ p0, p1, i, j, si, sj });
    }
  }
  return out;
}

// Closest point on segment e0-e1 to segment a-b, and the distance between them.
function closestOnEdge(e0, e1, a, b) {
  const d1 = sub(e1, e0), d2 = sub(b, a), r = sub(e0, a);
  const A = dot(d1, d1), E = dot(d2, d2), F = dot(d2, r), C = dot(d1, r), B = dot(d1, d2), den = A * E - B * B;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  let s = den > 1e-12 ? clamp((B * F - C * E) / den) : 0;
  let t = E > 1e-12 ? (B * s + F) / E : 0;
  if (t < 0) { t = 0; s = clamp(-C / A); } else if (t > 1) { t = 1; s = clamp((B - C) / A); }
  const p = add(e0, scale(d1, s)), q = add(a, scale(d2, t));
  return { p, dist: len(sub(p, q)) };
}

// Where the rope from pivot A, swept from the hero at P0 (clear) to P1 (blocked by box s), first touches s: the box
// edge met at the smallest sweep angle, pushed ropeWrapOffset outside both faces of that edge. With no usable sweep
// (P0 ~ P1, or the touch lies past the hero) the edge nearest the rope A-P1 is used. Null if nothing fits.
export function wrapPoint(s, A, P0, P1) {
  const u = sub(P0, A), v = sub(P1, A), N = cross(u, v), nl = len(N);
  let best = null;
  if (nl > 1e-6 * len(u) * len(v)) {
    const n = scale(N, 1 / nl), e1 = scale(u, 1 / len(u)), e2 = cross(n, e1);
    const angle = (w) => Math.atan2(dot(w, e2), dot(w, e1));
    const end = angle(v), reach = Math.max(len(u), len(v));
    for (const e of edges(s)) {
      const s0 = dot(sub(e.p0, A), n), s1 = dot(sub(e.p1, A), n);
      if (s0 * s1 > 0 || Math.abs(s0 - s1) < 1e-12) continue;
      const q = add(e.p0, scale(sub(e.p1, e.p0), s0 / (s0 - s1))), w = sub(q, A), th = angle(w);
      if (th < -1e-6 || th > end + 1e-6 || len(w) > reach) continue;
      if (!best || th < best.th) best = { th, q, e };
    }
  }
  if (!best) {
    for (const e of edges(s)) {
      const c = closestOnEdge(e.p0, e.p1, A, P1);
      if (!best || c.dist < best.dist) best = { dist: c.dist, q: c.p, e };
    }
  }
  const o = CFG.ropeWrapOffset, q = { ...best.q };
  q[best.e.i] += best.e.si * o; q[best.e.j] += best.e.sj * o;
  return q;
}

const pivotOf = (p) => (p.ropePoints.length ? p.ropePoints[p.ropePoints.length - 1] : p.anchor);

// One physics step of wrapping for an attached rope (call after the world step). P0 = the hero's position before the
// step. Unwraps bends the hero has swung back across, then wraps around whatever now cuts the free rope. Returns false
// if the rope must snap (more than ropeMaxWraps bends, or a bend that can't be placed); the caller releases it.
export function ropeStep(ph, p, P0, mask) {
  const P = plain(ph.hero.position), pts = p.ropePoints;
  const setFree = (l) => { ph.rope.distance = p.ropeLen = l; };
  while (pts.length) {
    const w = pts[pts.length - 1], Q = pts.length > 1 ? pts[pts.length - 2] : p.anchor;
    if (dot(cross(sub(w, Q), sub(P, w)), w.n) >= 0 || blocker(ph, P, Q, mask)) break;
    pts.pop();
    const l = len(sub(w, Q));
    setFree(ph.rope.distance + l);
    p.ropeMin += l;
    ph.anchor.position.set(Q.x, Q.y, Q.z);
  }
  for (;;) {
    const A = pivotOf(p), s = blocker(ph, P, A, mask);
    if (!s) return true;
    if (pts.length >= CFG.ropeMaxWraps) return false;
    const W = wrapPoint(s, A, P0, P), n = cross(sub(W, A), sub(P, W)), nl = len(n), l = len(sub(W, A));
    if (nl < 1e-9 || l < 0.05 || blocker(ph, W, A, mask) || ph.rope.distance - l < 0.3) return false;
    pts.push({ ...W, n: scale(n, 1 / nl) });
    setFree(ph.rope.distance - l);
    p.ropeMin -= l;
    ph.anchor.position.set(W.x, W.y, W.z);
  }
}
