const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const CFG = deepFreeze({
  maxDt: 0.05,
  // physics: cannon-es (vendor/cannon-es.js), SI units (m, s, kg)
  physicsStep: 1 / 120, // fixed step: each frame runs whole steps off an accumulator, so a dt sequence replays exactly
  gravity: 9.81,
  heroMass: 80,
  heroRadius: 0.5, // the hero's collision sphere
  airDrag: 0.003, // 1/m: quadratic drag, a = airDrag * v^2 (0.5 rho Cd A / m); terminal speed sqrt(g / airDrag) = 57 m/s
  heroFriction: 0, // the hero slides along facades instead of sticking
  heroRestitution: 0.2,
  bounceMinSpeed: 4, // m/s impact speed along the contact normal that counts as a 'bounce' (camera shake)
  corridorHalfWidth: 14, // tower faces line x = +-14 (the street corridor)
  viewDistance: 260, // structures exist this far ahead of the hero
  behindDistance: 40, // and are removed this far behind
  startHeight: 50,
  startSpeed: 12, // m/s forward at the start: a gentle leap, not a launch
  baseSpeed: 22, // render speed-feel reference only (fov and speed lines start here)
  maxSpeed: 60, // render speed-feel reference only (fov and speed lines are full here)
  aimAhead: 52, // m: every web meets its side's corridor face this far ahead of the hero (from the centre: yaw 15 deg)
  aimPitchDeg: { hi: 14, mid: 0, lo: -30 }, // from the centre: hi = 55.5 m web rising 13.4 m (was 25 deg: +25 m, out of view), mid 54 m level, lo 62 m dropping 31 m
  webRange: 135, // from beside one wall reaches the far wall
  webSpeed: 300, // m/s: a 54 m web lands in 0.18 s; a miss shows at full range after 0.45 s
  reelSpeed: 8, // m/s the held rope shortens at full reel (a hand-over-hand pull; the constraint turns it into tension)
  reelAccel: 6, // m/s^2 the reel spins up at once the rope is taut, so it never jerks the hero
  reelMinFactor: 0.5, // the reel stops at this fraction of the attach length
  minRopeLen: 3,
  ropeMaxForce: 1e5, // N, the rope's tension limit (an 80 kg hero at 40 m/s on a 30 m rope needs ~5 kN)
  ropeStiffness: 1e8, // cannon SPOOK constraint parameters for the rope
  ropeRelaxation: 2, // steps to correct a stretch: lower is stiffer (>= 1 stays stable)
  missShowSec: 0.25,
  // level generator (world.js); z is distance along the course
  level: {
    startZ: -20,
    easyZ: 400, // easy course before the difficulty ramp starts
    rampZ: 4000, // metres from easiest to hardest
    goodH: 42, // a tower on the corridor face at least this tall is a "sure anchor" (mid from <= 42 m, hi from <= 28 m)
    maxGapStart: 30, // longest z stretch with no sure anchor on either side, early..
    maxGapEnd: 70, // ..and late (a release at ~25 m/s carries > 100 m, so 70 m stays flyable)
    alleyStart: [0, 0.8], // empty z between lots: early seams are narrower than the hero (1 m), later alleys he can fall into
    alleyEnd: [2, 12],
    towerLen: [24, 70],
    towerHStart: [60, 120],
    towerHEnd: [42, 150],
    lowH: [12, 30],
    depth: [18, 34],
    sectionLen: [120, 320], // a stretch with buildings on both sides, or one side only
    oneSideStart: 0,
    oneSideEnd: 0.5,
    weightsStart: { tower: 1, low: 0, frame: 0, crane: 0, gap: 0 }, // lot kinds on a built-up side
    weightsEnd: { tower: 0.45, low: 0.15, frame: 0.15, crane: 0.1, gap: 0.15 },
    offWeights: { low: 0.4, frame: 0.2, gap: 0.4 }, // the empty side of a one-side stretch
    setbackChance: 0.35,
    setbackInset: [4, 8],
    setbackH: [10, 40],
    ledgeChance: 0.3,
    bridgeStart: 0, // chance a new tower gets a skybridge to an overlapping tower across the street (none in the easy start)
    bridgeEnd: 0.3,
    bridgeY: [30, 70],
    frameLen: [20, 40],
    frameDepth: [12, 22],
    frameH: [30, 70],
    beam: 1.6, // frame post/beam thickness: > 3 physics steps of travel at top speed, so nothing tunnels
    gapLen: [15, 45],
    craneLot: 18,
    craneH: [60, 100],
    craneReach: [6, 18], // the jib overhangs the street by this much
  },
  // game flow
  trickSec: 0.6,
  overFallSec: 1, // death fall animation before the result screen
  overInputDelaySec: 0.3, // ignore Space/Enter right after dying so a held key can't skip the result
  botWaitSec: 0.1, // ?autoplay and the headless bot test: free flight before the next press
  botReleaseClimb: 0.6, // let go past the swing bottom once climbing at 30 degrees (vel.y / speed)..
  botStallSpeed: 6, // ..or once the swing has slowed below this
  botRopeMin: 20, // the bot skips ropes shorter (a wall it is next to) or longer (a slow, low swing) than these
  botRopeMax: 120,
  // camera
  camNear: 0.5,
  camBack: 8.5,
  camUp: 2.2,
  camFollow: 7, // 1/s, exponential smoothing rate
  fovMin: 62,
  fovMax: 92,
  fovFollow: 3,
  maxDpr: 2,
  // hand input
  handStableFrames: 2, // shoot gesture this many frames in a row = press (1 = fastest, but one bad frame fires a web)
  handReleaseFrames: 3, // non-shoot frames in a row = release (debounced: a flicker must not drop the rope)
  // finger bend = 3D angle MCP->PIP vs PIP->TIP in degrees (0 straight, ~130 folded onto the palm)
  handStraightDeg: 30, // 'open': all four fingers bend below this
  handExtendDeg: 60, // 'shoot': index and pinky bend below this ...
  handCurlDeg: 40, // ... and middle and ring bend above this (half-curled still counts)
  handFistDeg: 90, // 'fist': all four bend above this
  handHystDeg: 10, // the gesture held last frame gets its thresholds loosened by this much
  handSideMinScore: 0.8, // handedness score at or above this picks the side by hand; below = screen half (>1 = always screen half)
  handMinConfidence: 0.35, // MediaPipe detection / presence / tracking confidence (default 0.5)
  handLostMs: 300, // hand unseen this long while charging = cancel
  handLevelCuts: [1 / 3, 2 / 3], // wrist y (0 = top) below these: hi, mid; else lo
  handPromptTimeoutSec: 15, // camera permission prompt nobody answers = give up (hand 'failed', H retries)
  handRestartSec: 1, // open palm held this long on title/result = start
  handMatchMaxDist: 0.2, // wrist moved farther than this (screen fraction) between frames = a different hand
  // render
  render: {
    // camera (the top-level cam*/fov* keys were the old canvas camera's; three.js uses these)
    camBack: 5, // m behind the hero: the ~1.8 m hero is ~1/4 of the screen at fovMin
    camUp: 1.4,
    lookAhead: 0.12, // s: the camera looks at pos + vel * lookAhead
    lookUp: 0.6,
    camWallGap: 4, // m: the camera stays this far inside the corridor walls
    camSnap: 80, // m: a bigger jump (restart) snaps the camera instead of easing
    fovMin: 58,
    fovMax: 84,
    near: 0.1,
    far: 1700,
    fogDensity: 0.0042, // exp2: ~66% hazed at the 260 m spawn horizon, opaque by ~400 m
    // city
    floorH: 3,
    windowColSpacing: 2.5,
    texCols: 8, // the window texture tile is texCols x texRows windows
    texRows: 8,
    windowLit: 0.38,
    windowStyles: [[0.6, 0.55], [0.42, 0.92], [0.92, 0.86]], // [glass w, glass h] as a fraction of a cell
    facadeTints: [[128, 112, 103], [143, 137, 128], [72, 104, 132], [150, 141, 129], [112, 106, 98]],
    skylineTints: [[60, 66, 104], [78, 70, 106], [52, 72, 100]],
    depthMin: 18,
    depthMax: 34,
    tankChance: 0.55,
    antennaChance: 0.4,
    antennaH: 14,
    skylineCount: 260,
    skylineXMin: 60,
    skylineXMax: 460,
    skylineSpan: 1000, // skyline boxes wrap over [cam z - skylineBack, cam z - skylineBack + skylineSpan]
    skylineBack: 250,
    streetLightSpacing: 14,
    streetLightXs: [-62, -44, -26, -14, 14, 26, 44, 62],
    streetLightY: 6,
    carSpacing: 9,
    carSpeed: 18,
    carLanes: [-8, -3, 3, 8],
    carGapChance: 0.55,
    streetSpan: 700, // street lights and cars wrap over this many metres around the camera
    sunDir: [0.08, 0.1, 1], // world coords: low sun at the far end of the street
    // rope / web
    ropeRadius: 0.018, // min; drawn radius = camera distance * ropeRadiusPerM (~constant px width)
    ropeRadiusPerM: 0.0012,
    ropeMaxRadius: 0.16,
    splatSize: 1.8,
    playerHand: 0.9, // game.js casts from here; the drawn rope leaves the rig's hand instead
    // speed feel
    speedLineStart: 1.3, // * baseSpeed
    speedLineFull: 2.4,
    speedLineCount: 48,
    shakeFreqX: 47,
    shakeFreqY: 61,
    shakeM: 0.03, // metres of camera shake per unit of view.shake
    shakePeak: 7,
    shakeDecay: 9,
    bounceShake: 3,
  },
  hud: {
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    titlePx: 72,
    textPx: 20,
    hudPx: 28,
    margin: 16,
    lineGap: 1.6, // line height as a multiple of the font size
    color: '#ffffff',
    dim: 'rgba(255,255,255,0.45)',
    accent: '#ffd54a',
    backdrop: 'rgba(5,6,20,0.55)',
  },
  colors: {
    skyTop: '#0b1033',
    skyMid: '#3a3f8f',
    skyHorizon: '#f28a5b',
    ground: '#07070f',
    groundFar: '#251f3a',
    street: '#14121f',
    streetLight: '#ffcf7a',
    carHead: '#fff2d0',
    carTail: '#ff3b3b',
    faceNear: [70, 78, 112],
    faceFar: [150, 120, 160], // haze tint toward the horizon
    roof: '#1b1f35',
    endFace: '#2c3150',
    windowLit: [255, 216, 138],
    windowDark: '#10142a',
    mullion: '#20253f',
    skylineLit: '#ffd88a',
    web: '#f4f4f8',
    aim: 'rgba(255,255,255,0.85)',
    speedLine: 'rgba(255,255,255,0.8)',
    suitRed: '#d3162b',
    suitDark: '#7a0b18',
    suitBlack: '#121218',
    lens: '#f4f6ff',
  },
  character: {
    height: 1.85, // metres; long-legged athletic rig, pelvis at player.pos
    blendRate: 12, // 1/s, pose-to-pose easing
    turnRate: 8, // 1/s, body orientation easing
    flailSpeed: 14,
    flailAmp: 0.5,
    blue: '#1d2f8a',
    // Joint Euler angles [x, y, z] in radians. Limbs hang down (-y) at rest; +x swings a limb backward,
    // +z raises a right limb sideways. Left joints use the mirrored sign, so symmetric poses read alike.
    // Swing is authored with the web in the right hand; character.js mirrors it for a left anchor.
    poses: {
      swing: { spine: [0.15, 0, 0], neck: [-0.25, 0, 0], shL: [0.35, 0, 0.55], elL: [-0.9, 0, 0], shR: [0, 0, 2.9], elR: [0, 0, 0], hipL: [0.55, 0, 0.12], knL: [1.0, 0, 0], hipR: [0.15, 0, 0.06], knR: [0.35, 0, 0] },
      glide: { spine: [-0.1, 0, 0], neck: [-0.7, 0, 0], shL: [-0.2, 0, 1.55], elL: [-0.25, 0, 0], shR: [-0.2, 0, 1.55], elR: [-0.25, 0, 0], hipL: [0.1, 0, 0.5], knL: [0.25, 0, 0], hipR: [0.1, 0, 0.5], knR: [0.25, 0, 0] },
      roll: { spine: [-0.2, 0, 0.25], neck: [-0.3, 0, 0], shL: [-0.4, 0, 1.25], elL: [-0.7, 0, 0], shR: [-0.8, 0, 0.8], elR: [-1.2, 0, 0], hipL: [-0.7, 0, 0.3], knL: [1.1, 0, 0], hipR: [-0.1, 0, 0.15], knR: [0.35, 0, 0] },
      tuck: { spine: [-0.6, 0, 0], neck: [-0.4, 0, 0], shL: [-1.4, 0, 0.2], elL: [-1.6, 0, 0], shR: [-1.4, 0, 0.2], elR: [-1.6, 0, 0], hipL: [-2.3, 0, 0.1], knL: [2.5, 0, 0], hipR: [-2.3, 0, 0.1], knR: [2.5, 0, 0] },
      fall: { spine: [0.25, 0, 0], neck: [-0.5, 0, 0], shL: [0, 0, 2.5], elL: [-0.7, 0, 0], shR: [0.2, 0, 2.1], elR: [-0.5, 0, 0], hipL: [-0.5, 0, 0.35], knL: [1.1, 0, 0], hipR: [0.2, 0, 0.2], knR: [0.6, 0, 0], flail: 1 },
    },
    tricks: ['roll', 'tuck', 'glide'],
  },
  keys: {
    KeyQ: ['L', 'hi'], KeyA: ['L', 'mid'], KeyZ: ['L', 'lo'],
    KeyE: ['R', 'hi'], KeyD: ['R', 'mid'], KeyC: ['R', 'lo'],
  },
});
