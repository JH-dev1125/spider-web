const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const CFG = deepFreeze({
  maxDt: 0.05,
  gravity: 18,
  corridorHalfWidth: 14,
  viewDistance: 260,
  behindDistance: 40,
  startHeight: 60, // forward webs mean long ropes: start higher so the first swings clear the street
  ceiling: 160, // hMax = 144: room for hi anchors well above the hand
  baseSpeed: 22,
  maxSpeed: 60,
  speedRampPerSec: 0.25,
  easySeconds: 20,
  rampSeconds: 180,
  startZ: -20,
  gapMinStart: 4,
  gapMaxStart: 14,
  gapMinEnd: 10,
  gapMaxEnd: 40,
  lenMin: 30,
  lenMax: 80,
  hMinStartFactor: 1.6, // 96 m early: hi from the start height (anchor ~86 m) usually lands
  hMinEndFactor: 1.1,
  hMaxFactor: 0.9,
  aimYawDeg: 15, // angle off straight-ahead: from the corridor centre every level lands 14/tan(15) = 52 m ahead
  aimPitchDeg: { hi: 25, mid: 0, lo: -30 }, // from the centre: hi = 60 m web rising 25 m, mid 54 m, lo 63 m dropping 31 m
  chargeMin: 12,
  chargeMax: 70,
  chargeFullSec: 1.0, // chargeMin/Max/FullSec: legacy charge preview (render.js chargeLength), unused by play
  webRange: 135, // from beside one wall reaches the far wall (hi: 28 m across = 123 m web, ~100 m ahead)
  webSpeed: 300, // m/s: a 60 m web lands in 0.2 s; a miss shows at full range after 0.45 s
  reelSpeed: 25, // m/s the held rope shortens: ~0.4 m per frame, no snap on attach
  reelMinFactor: 0.6, // reel stops at this fraction of the attach length; >= 0.63 the bot sinks, <= 0.55 it overshoots roofs
  minRopeLen: 3,
  releaseBoostUp: 8,
  releaseBoostForward: 4,
  wallBounceLoss: 0.5,
  wallSkin: 0.05,
  bounceMinSpeed: 2,
  wallPushOff: 10, // m/s inward when free flight touches a face slower than bounceMinSpeed
  missShowSec: 0.25,
  // game flow
  trickSec: 0.6,
  overFallSec: 1, // death fall animation before the result screen
  overInputDelaySec: 0.3, // ignore Space/Enter right after dying so a held key can't skip the result
  botWaitSec: 0.1, // ?autoplay and the headless bot test: free flight before the next press
  botHoldAfterBottomSec: 0.2, // hold this long past the swing bottom, then let go
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
  handStableFrames: 3, // same gesture this many frames in a row before it counts
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
    facadeTints: [[86, 96, 140], [112, 92, 128], [72, 104, 132], [120, 114, 142], [96, 84, 110]],
    skylineTints: [[60, 66, 104], [78, 70, 106], [52, 72, 100]],
    depthMin: 18,
    depthMax: 34,
    corniceH: 0.8,
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
    ropeRadius: 0.012, // min; drawn radius = camera distance * ropeRadiusPerM (~constant px width)
    ropeRadiusPerM: 0.0035,
    ropeMaxRadius: 0.6,
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
    height: 1.8, // metres; the rig in character.js is built to this
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
      roll: { spine: [-0.45, 0, 0], neck: [-0.3, 0, 0], shL: [-1.1, 0, 0.35], elL: [-1.9, 0, 0], shR: [-1.1, 0, 0.35], elR: [-1.9, 0, 0], hipL: [-2.1, 0, 0.18], knL: [2.4, 0, 0], hipR: [-2.1, 0, 0.18], knR: [2.4, 0, 0] },
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
