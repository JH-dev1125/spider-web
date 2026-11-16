import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { createPlayer, createPhysics, syncStructures, raycast, attach, release, stepPhysics, setZip } from '../src/player.js';

const DT = 1 / 60;
const H = CFG.physicsStep;
const box = (id, kind, min, max, attachable = kind !== 'frame') => ({ id, kind, min, max, attach: attachable });
const len3 = (v) => Math.hypot(v.x, v.y, v.z);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function setup({ pos, vel, structures = [] } = {}) {
  const p = createPlayer();
  if (pos) p.pos = { ...pos };
  if (vel) p.vel = { ...vel };
  const ph = createPhysics(p);
  syncStructures(ph, structures);
  return { p, ph };
}
const inside = (p, s) => ['x', 'y', 'z'].every((k) => p[k] > s.min[k] && p[k] < s.max[k]);

test('free flight: plain gravity plus a little quadratic drag', () => {
  const { p, ph } = setup({ vel: { x: 0, y: 0, z: 0 } });
  for (let i = 0; i < 60; i++) stepPhysics(ph, p, DT);
  const velocity = Object.values(ph.rag.bodies).reduce((v, b) => v + b.velocity.y * b.mass / CFG.heroMass, 0);
  const vt = Math.sqrt(CFG.gravity / CFG.airDrag), vy = -vt * Math.tanh(CFG.gravity / vt); // falling from rest for 1 s
  assert.ok(Math.abs(velocity - vy) < 0.07 && velocity > -CFG.gravity, `vy ${p.vel.y} vs ${vy}`);
  assert.ok(Math.abs(p.pos.y - (CFG.startHeight - 0.5 * CFG.gravity)) < 0.15);
});

test('fixed step: dt is consumed in whole physics steps, the remainder carries over', () => {
  const a = setup(), b = setup();
  for (let i = 0; i < 120; i++) stepPhysics(a.ph, a.p, DT);
  for (let i = 0; i < 240; i++) stepPhysics(b.ph, b.p, DT / 2);
  assert.ok(dist(a.p.pos, b.p.pos) < 1e-9); // same steps, same result
  const c = setup();
  stepPhysics(c.ph, c.p, H * 0.5);
  assert.equal(c.p.pos.y, CFG.startHeight); // not a whole step yet
});

test('air drag caps the fall near sqrt(g / airDrag)', () => {
  const { p, ph } = setup({ pos: { x: 0, y: 3000, z: 0 }, vel: { x: 0, y: 0, z: 0 } });
  for (let i = 0; i < 60 * 30; i++) stepPhysics(ph, p, DT);
  const vt = Math.sqrt(CFG.gravity / CFG.airDrag);
  assert.ok(Math.abs(-p.vel.y - vt) < 1, `${-p.vel.y} vs ${vt}`);
});

test('the rope pulls but never pushes; held taut it keeps the hero within its length', () => {
  const anchor = { x: 0, y: 60, z: 30 };
  const { p, ph } = setup({ pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 10 } });
  assert.ok(attach(ph, p, anchor));
  for (let i = 0; i < 240; i++) {
    stepPhysics(ph, p, DT);
    // SPOOK lags the reel by about one step
    assert.ok(dist(ph.rope.bodyA.position, anchor) <= p.ropeLen + CFG.reelSpeed * H * 1.5 + 0.01, `stretched at frame ${i}`);
  }
  // hero flying straight at the anchor: the rope goes slack and takes up the slack without pushing back
  const s = setup({ pos: { x: 0, y: 60, z: 0 }, vel: { x: 0, y: 0, z: 20 } });
  attach(s.ph, s.p, anchor);
  stepPhysics(s.ph, s.p, DT);
  assert.ok(Math.abs(Object.values(s.ph.rag.bodies).reduce((v,b)=>v+b.velocity.z*b.mass/CFG.heroMass,0) - 20 * (1-CFG.airDrag*20*DT)) < .02);
  assert.equal(s.ph.rope.distanceEquation.maxForce, 0);
});

test('the rope only ever shortens: reeled smoothly to ropeMin (slack take-up may go shorter)', () => {
  const anchor = { x: 14, y: 80, z: 40 };
  const { p, ph } = setup({ pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 0 } });
  attach(ph, p, anchor);
  const L0 = p.ropeLen;
  assert.equal(p.ropeMin, L0 * CFG.reelMinFactor);
  let prev = L0;
  for (let i = 0; i < 60 * 8; i++) {
    stepPhysics(ph, p, DT);
    assert.ok(p.ropeLen <= prev + 1e-9 && p.ropeLen >= CFG.minRopeLen);
    assert.ok(ph.reelRate <= CFG.reelSpeed && ph.reelRate >= 0, 'winch speed bounded; slack take-up can be faster');
    prev = p.ropeLen;
  }
  assert.ok(p.ropeLen <= p.ropeMin + 1e-9);
});

test('release removes the rope and leaves the velocity exactly as the swing made it', () => {
  const { p, ph } = setup({ vel: { x: 0, y: 0, z: 12 } });
  attach(ph, p, { x: -14, y: 64, z: 52 });
  for (let i = 0; i < 150; i++) stepPhysics(ph, p, DT);
  const v = { ...p.vel };
  const hv = ph.hero.velocity;
  assert.ok(release(ph, p));
  assert.deepEqual({ x: hv.x, y: hv.y, z: hv.z }, v);
  assert.equal(p.anchor, null);
  assert.equal(ph.world.constraints.length, 14);
  assert.equal(release(ph, p), false);
});

test('solid: a hero thrown at 57 m/s into a tower or a frame beam never ends up inside it', () => {
  const W = CFG.corridorHalfWidth;
  const tower = box('t:base', 'tower', { x: W, y: 0, z: 0 }, { x: W + 20, y: 100, z: 200 });
  const beam = box('f:post0', 'frame', { x: -0.8, y: 0, z: 60 }, { x: 0.8, y: 100, z: 60 + CFG.level.beam });
  for (const [s, vel] of [[tower, { x: 57, y: 0, z: 5 }], [beam, { x: 0, y: 0, z: 57 }], [tower, { x: 40, y: 0, z: 40 }]]) {
    const { p, ph } = setup({ pos: { x: 0, y: 60, z: 10 }, vel, structures: [s] });
    for (let i = 0; i < 120; i++) {
      stepPhysics(ph, p, DT);
      for(const b of Object.values(ph.rag.bodies)) assert.ok(!inside(b.position, s), `${s.id}: ${b.part} inside at frame ${i}`);
    }
  }
});

test('raycast: closest hit, attach comes from the structure, frames and the street do not hold', () => {
  const W = CFG.corridorHalfWidth;
  const frame = [
    box('f:post0', 'frame', { x: W, y: 0, z: 40 }, { x: W + 1.6, y: 40, z: 41.6 }),
    box('f:post1', 'frame', { x: W, y: 0, z: 70 }, { x: W + 1.6, y: 40, z: 71.6 }),
    box('f:beam0', 'frame', { x: W, y: 38.4, z: 40 }, { x: W + 1.6, y: 40, z: 71.6 }),
  ];
  const behind = box('t:base', 'tower', { x: W + 20, y: 0, z: 0 }, { x: W + 40, y: 80, z: 200 });
  const { ph } = setup({ structures: [...frame, behind] });
  const from = { x: 0, y: 20, z: 0 };
  const through = raycast(ph, from, { x: Math.sin(0.3), y: 0, z: Math.cos(0.3) }, 200); // through the frame's open middle
  assert.ok(through.attach && Math.abs(through.point.x - (W + 20)) < 1e-6);
  const d = { x: W + 0.8, y: 0, z: 40.8 }; // straight at the first post
  const post = raycast(ph, from, { x: d.x / len3(d), y: 0, z: d.z / len3(d) }, 200);
  assert.ok(post && !post.attach && post.point.x >= W - 1e-6 && post.point.x < W + 1.6, 'a post blocks the web');
  const street = raycast(ph, from, { x: 0, y: -1, z: 0 }, 200);
  assert.ok(street && !street.attach && Math.abs(street.point.y) < 1e-6);
  assert.equal(raycast(ph, from, { x: -1, y: 0, z: 0 }, 50), null);
});

test('syncStructures adds new boxes and removes the ones the world dropped', () => {
  const a = box('a:base', 'tower', { x: 14, y: 0, z: 0 }, { x: 30, y: 50, z: 40 });
  const b = box('b:base', 'tower', { x: -30, y: 0, z: 0 }, { x: -14, y: 50, z: 40 });
  const { ph } = setup({ structures: [a, b] });
  assert.deepEqual([...ph.boxes.keys()], ['a:base', 'b:base']);
  syncStructures(ph, [b]);
  assert.deepEqual([...ph.boxes.keys()], ['b:base']);
  assert.ok(!ph.world.bodies.some((x) => x.structure === a));
});

test('touching the street is death: one event, detached rope, limp body settles', () => {
  const { p, ph } = setup({ pos: { x: 0, y: 5, z: 0 } });
  assert.ok(attach(ph, p, { x: 14, y: 4, z: 30 })); // a low anchor cannot hold him up
  const ev = [];
  for (let i = 0; i < 180; i++) ev.push(...stepPhysics(ph, p, DT));
  assert.deepEqual(ev.filter((e) => e === 'dead'), ['dead']);
  assert.equal(p.alive, false);
  assert.equal(p.anchor, null);
  assert.ok(len3(p.vel) < .5, JSON.stringify(p.vel));
});

test('landing on a roof never leaves the hero stuck: he runs forward off the edge', () => {
  const p = createPlayer();
  p.pos = { x: 0, y: 31.04, z: 0 };
  p.vel = { x: 0, y: 0, z: 0 };
  const ph = createPhysics(p);
  syncStructures(ph, [{ id: 'roof', kind: 'tower', min: { x: -10, y: 0, z: -5 }, max: { x: 10, y: 30, z: 6 }, attach: true }]);
  for (let i = 0; i < 60 * 10 && p.alive; i++) stepPhysics(ph, p, 1 / 60);
  assert.ok(p.pos.z > 6 || !p.alive, `still on the roof at z=${p.pos.z}`);
});

// ---- wall run: a side-face hit with speed into it runs along the face, then jumps off ----
const W = CFG.corridorHalfWidth;
const face = () => box('wr:base', 'tower', { x: W, y: 0, z: -50 }, { x: W + 20, y: 150, z: 400 });
function throwAtWall(vel, structures = [face()]) {
  const s = setup({ pos: { x: W - 3, y: 60, z: 0 }, vel, structures });
  const log = []; // per frame {ev, pos, vel}
  for (let i = 0; i < 210; i++) {
    const ev = stepPhysics(s.ph, s.p, DT);
    log.push({ axis: Math.abs(s.ph.hero.quaternion.vmult({x:0,y:1,z:0}).x),
      gait: Object.fromEntries(Object.entries(s.ph.gait || {}).map(([side, g]) => [side, {plants:g.plants, pin:!!g.pin}])), ev, pos: { ...s.p.pos }, vel: { ...s.p.vel }, wall: s.p.wall });
    for (const b of structures) assert.ok(!inside(s.p.pos, b), `inside ${b.id} at frame ${i}`);
  }
  return { ...s, log };
}

test('wall walk: perpendicular body, alternating planted soles, timed kick-off', () => {
  const { log } = throwAtWall({ x: 15, y: -6, z: 20 });
  const r = log.findIndex(f => f.ev.includes('wallrun')), j = log.findIndex(f => f.ev.includes('walljump'));
  assert.ok(r >= 0 && j > r, 'run then jump');
  assert.ok(Math.abs((j-r)*DT-CFG.wallRunSec) <= 2*DT && (j-r)*DT < 3);
  const run = log.slice(r+36, j); // physical turn takes 0.6 s; no pose is pinned at entry
  assert.ok(run.every(f => f.axis >= Math.cos(Math.PI/6)), 'long axis >30 degrees from wall normal');
  for (const side of ['L','R']) {
    assert.ok(Math.max(...run.map(f => f.gait[side]?.plants || 0)) >= 2, side+' did not step twice');
    assert.ok(run.some(f=>f.gait[side]?.pin) && run.some(f=>!f.gait[side]?.pin), side+' never lifted');
  }
  assert.ok(run.every(f => f.wall === -1 && W-f.pos.x > .6 && W-f.pos.x < 1.0));
  assert.ok(run.at(-1).pos.z > run[0].pos.z + 1, 'walk advances along facade');
});

test('wall jump: contact stance kicks away, upward and forward', () => {
  const { log } = throwAtWall({ x: 15, y: -6, z: 20 });
  const j = log.findIndex((f) => f.ev.includes('walljump'));
  const v = log[j].vel;
  assert.ok(v.x < -CFG.wallJump.out * 0.9, `vx ${v.x}`);
  assert.ok(v.y > CFG.wallJump.up * 0.8, `vy ${v.y}`);
  assert.ok(v.z > 3, `vz ${v.z}`);
  assert.ok(log.at(-1).pos.x < W - 3, 'flew off the wall');
});

test('friction: full-body facade contacts cost speed without sticking', () => {
  const vel = { x: CFG.wallRunMinSpeed * 0.8, y: 0, z: 20 }; // too slow into the face for a wall run
  const graze = throwAtWall(vel), free = throwAtWall(vel, []);
  assert.ok(!graze.log.some((f) => f.ev.includes('wallrun')));
  const vz = graze.log.at(-1).vel.z, vzFree = free.log.at(-1).vel.z;
  assert.ok(vz < vzFree - 0.05 && vz > 0.65 * vzFree, `grazed ${vz.toFixed(2)} vs ${vzFree.toFixed(2)} m/s`);
  assert.ok(graze.log.at(-1).pos.z > 25, 'kept going along the wall');
});

test('wall run: a slow bump or a roof landing is no wall run', () => {
  assert.ok(!throwAtWall({ x: CFG.wallRunMinSpeed * 0.5, y: 0, z: 10 }).log.some((f) => f.ev.includes('wallrun')));
  const roof = setup({ pos: { x: W + 10, y: 152, z: 0 }, vel: { x: 0, y: -8, z: 10 }, structures: [face()] });
  for (let i = 0; i < 30; i++) assert.ok(!stepPhysics(roof.ph, roof.p, DT).includes('wallrun'));
});

test('wall run cooldown: driven straight back into the face, no new run until wallRunCooldownSec', () => {
  const { p, ph } = setup({ pos: { x: W - 3, y: 60, z: 0 }, vel: { x: 15, y: 0, z: 20 }, structures: [face()] });
  let t = 0, jumpT = null, again = null;
  for (let i = 0; i < 180; i++, t += DT) {
    if (jumpT !== null) for(const b of Object.values(ph.rag.bodies)) b.velocity.x = 12; // keep shoving him into the wall
    const ev = stepPhysics(ph, p, DT);
    if (ev.includes('walljump') && jumpT === null) jumpT = t;
    else if (ev.includes('wallrun') && jumpT !== null) { again = t; break; }
  }
  assert.ok(jumpT !== null && again !== null, 'ran again once the cooldown was over');
  assert.ok(again - jumpT >= CFG.wallRunCooldownSec - DT, `ran again after ${(again - jumpT).toFixed(2)} s`);
});

test('wall run with a rope: the rope still holds him, and a zip into a wall lands in a wall run', () => {
  const anchor = { x: W, y: 90, z: 60 };
  const s = setup({ pos: { x: W - 3, y: 60, z: 0 }, vel: { x: 15, y: 0, z: 20 }, structures: [face()] });
  assert.ok(attach(s.ph, s.p, anchor));
  let ran = false;
  for (let i = 0; i < 60; i++) {
    ran = stepPhysics(s.ph, s.p, DT).includes('wallrun') || ran;
    assert.ok(dist(s.ph.rope.bodyA.position, anchor) <= s.p.ropeLen + 0.3, `rope stretched at frame ${i}`);
  }
  assert.ok(ran && s.p.anchor, 'ran along the wall on the rope');
  // zip at a wall anchor ahead: auto-release short of it, the momentum carries him into the face, a wall run
  const z = setup({ pos: { x: 0, y: 60, z: 0 }, vel: { x: 0, y: 0, z: 12 }, structures: [face()] });
  attach(z.ph, z.p, { x: W, y: 62, z: 30 });
  setZip(z.ph, true);
  const ev = [];
  for (let i = 0; i < 120; i++) {
    ev.push(...stepPhysics(z.ph, z.p, DT));
    assert.ok(!inside(z.p.pos, face()), `zip: inside at frame ${i}`);
  }
  assert.ok(ev.includes('zipped'), 'zip let go');
  assert.ok(ev.indexOf('wallrun') > ev.indexOf('zipped'), `events ${ev.join(' ')}`);
});

test('ragdoll owns 70 kg, fourteen limited joints and the rope on a hand; release changes no velocities', () => {
  const {p,ph}=setup();
  assert.equal(Object.keys(ph.rag.bodies).length,15);
  assert.equal(Object.values(ph.rag.bodies).reduce((m,b)=>m+b.mass,0),70);
  assert.equal(ph.rag.joints.length,14);
  for(const j of ph.rag.joints) assert.ok(j.joint.equations.length>=5 && !j.joint.collideConnected);
  attach(ph,p,{x:-14,y:65,z:40});assert.equal(ph.rope.bodyA,ph.rag.bodies.handL);
  for(let i=0;i<120;i++)stepPhysics(ph,p,DT);
  const velocities=Object.values(ph.rag.bodies).map(b=>b.velocity.toString());
  release(ph,p);assert.deepEqual(Object.values(ph.rag.bodies).map(b=>b.velocity.toString()),velocities);
});

test('wall soles hold their contact point and visibly lift between plants on both facades', () => {
  for(const side of [-1,1]) {
    const structure=side===1?face():box('left','tower',{x:-34,y:0,z:-50},{x:-14,y:150,z:400});
    const {p,ph}=setup({pos:{x:side*11,y:60,z:0},vel:{x:side*15,y:-6,z:20},structures:[structure]});
    const pins=new Map(),counts={L:0,R:0},lifts={L:0,R:0};let angleMin=1;
    for(let i=0;i<155;i++){
      stepPhysics(ph,p,DT);
      if(ph.wall?.sec>.6) {
        const head=ph.rag.bodies.head.position,feet=ph.rag.bodies.footL.position.vadd(ph.rag.bodies.footR.position).scale(.5);
        const axis=head.vsub(feet);angleMin=Math.min(angleMin,Math.abs(axis.x)/axis.length());
      }
      for(const [s,g] of Object.entries(ph.gait||{})){
        counts[s]=Math.max(counts[s],g.plants);
        const foot=ph.rag.bodies['foot'+s],sole=foot.pointToWorldFrame({x:0,y:-.045,z:0});
        if(g.pin){const prev=pins.get(s);if(prev?.pin===g.pin)assert.ok(sole.distanceTo(prev.point)<.08,'sole slid '+s);pins.set(s,{pin:g.pin,point:sole.clone()});}
        else if(g.plants)lifts[s]=Math.max(lifts[s],Math.abs(sole.x-side*14));
      }
    }
    assert.ok(angleMin>=Math.cos(Math.PI/6),'head-to-feet axis '+angleMin);
    for(const s of ['L','R']){assert.ok(counts[s]>=2,s);assert.ok(lifts[s]>.15,s+' never lifted away');}
  }
});
