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
  ceiling: 160, // hMax = 144: room for hi anchors ~40 m above the hand
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
  hMinStartFactor: 1.6, // 96 m early: hi from the start height (anchor ~100 m) usually lands
  hMinEndFactor: 1.1,
  hMaxFactor: 0.9,
  aimYawDeg: 25, // angle off straight-ahead: from the corridor centre every level lands 14/tan(25) = 30 m ahead
  aimPitchDeg: { hi: 50, mid: 0, lo: -35 }, // hi 50: sin(50) ~ reelFactor, so a hi swing bottoms at the press height
  chargeMin: 12,
  chargeMax: 70,
  chargeFullSec: 1.0, // chargeMin/Max/FullSec: legacy charge preview (render.js chargeLength), unused by play
  webRange: 85, // reaches the far wall from ~8 m off centre; longer cross shots dropped the bot into the street
  reelFactor: 0.8, // swing bottom = press height + t*(sin(pitch) - reelFactor), t = web length
  minRopeLen: 3,
  releaseBoostUp: 6, // was 9; with level hi swings 9 pumped the hero above the rooftops (hi then misses)
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
  botWaitSec: 0.3, // ?autoplay and the headless bot test: free flight before the next press
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
    clipNear: 1, // geometry is clipped this far in front of the camera
    skyline: [ // far -> near; parallax = px scrolled per metre of cam.z
      { colW: 34, hMin: 0.03, hMax: 0.13, parallax: 0.04, color: '#5d6f9e' },
      { colW: 52, hMin: 0.05, hMax: 0.22, parallax: 0.12, color: '#3a4572' },
      { colW: 78, hMin: 0.08, hMax: 0.32, parallax: 0.3, color: '#232a4d' },
    ],
    skylineLitChance: 0.35,
    skylineLitPerCol: 4,
    skylineLitPx: 2,
    streetLightSpacing: 14,
    streetLightXs: [-62, -44, -26, -14, 14, 26, 44, 62],
    streetLightMin: 1,
    streetLightSize: 0.6,
    carSpacing: 9,
    carSpeed: 18,
    carLanes: [-8, -3, 3, 8],
    carGapChance: 0.55,
    buildingDepth: 22,
    // facade LOD by distance from the camera: window grid < gridDist < stripes < stripeDist < flat + fog
    floorH: 3,
    windowColSpacing: 2.5,
    gridDist: 70,
    stripeDist: 170,
    gridRowsMax: 32, // per column, only rows inside the screen
    gridColsMax: 28,
    // per-building window style, picked by hash: [glass width, glass height] as a fraction of a cell, lit chance
    windowStyles: [
      { gw: 0.6, gh: 0.55, lit: 0.55, glass: 'dark' }, // punched grid
      { gw: 0.42, gh: 1, lit: 0.5, glass: 'dark' }, // vertical strips
      { gw: 0.94, gh: 0.9, lit: 0.3, glass: 'curtain' }, // glass curtain wall
    ],
    facadeTints: [[70, 78, 112], [92, 76, 104], [58, 84, 106], [96, 92, 116]],
    curtainGlass: [34, 52, 92],
    corniceH: 0.8,
    corniceColor: '#7d86b0',
    tankChance: 0.5,
    antennaChance: 0.4,
    antennaH: 14,
    antennaLight: '#ff4a4a',
    tankColor: '#3a3048',
    tankTop: '#544463',
    mullionMaxPx: 5,
    sunX: 0.03, // fraction of the width right of centre: low sun at the end of the street
    sunGlow: 'rgba(255,190,120,0.55)',
    hazeGlow: 'rgba(255,170,120,0.18)',
    vignette: 'rgba(4,4,18,0.5)',
    fogSteps: 8,
    webWidth: 0.06,
    webMinPx: 1.5,
    webMaxPx: 5,
    aimDash: [6, 6],
    aimWidthPx: 2,
    aimDotPx: 4,
    playerHand: 0.9, // web leaves the hand ~0.9 m above the body centre
    speedLineStart: 1.3, // * baseSpeed
    speedLineFull: 2.4,
    speedLineCount: 48,
    speedLineRate: 1.6,
    speedLineLen: 0.22, // fraction of the screen half-diagonal
    speedLineInner: 0.45,
    speedLineWidth: 2.5,
    speedLineMinFrac: 0.3,
    shakeFreqX: 47,
    shakeFreqY: 61,
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
    height: 1.8, // metres
    drawScale: 1.35, // drawn larger than life so the hero reads at play distance
    minPx: 95, // body unit clamp in px; the figure is ~0.95 units tall
    maxPx: 135,
    rollSpeed: 9, // rad/s
    flailSpeed: 14,
    flailAmp: 0.45,
    blendRate: 14, // 1/s, pose-to-pose easing
    // back view, unit = drawn body unit, y down, origin = body centre
    body: {
      headY: -0.375, headR: 0.078,
      shoulderX: 0.115, shoulderY: -0.265, chestW: 0.13, waistW: 0.075, waistY: 0.02, hipX: 0.055, hipY: 0.04,
      arm: [0.15, 0.14], armW: [0.062, 0.05], handR: 0.033,
      leg: [0.2, 0.2], legW: [0.085, 0.06], footR: 0.038,
      halo: 0.03, outline: 0.014, webW: 0.006, lensW: 0.55, lensH: 0.62,
    },
    palette: {
      blue: '#1d2f8a', web: '#3a0610', emblem: '#0c0c14',
      outline: '#16060c', halo: 'rgba(255,214,170,0.32)', lensRim: '#0c0c14', shade: 'rgba(40,0,20,0.28)',
    },
    // limbs: [upper rad, lower rad relative, upper len scale, lower len scale]; 0 = straight down, + = away
    // from the body. lean = body tilt rad (+ = toward the web hand), look = head turn -1..1 (lens shows).
    poses: {
      swing: { armL: [0.75, 0.9, 1, 1], armR: [2.95, 0.12, 1, 1], legL: [0.32, -0.95, 0.9, 0.8], legR: [0.08, -0.35, 0.95, 0.9], lean: 0.22, look: 0.8, spin: 0, flail: 0 },
      glide: { armL: [1.75, 0.25, 1, 1], armR: [1.75, 0.25, 1, 1], legL: [0.42, 0.2, 1, 1], legR: [0.42, 0.2, 1, 1], lean: 0, look: 0, spin: 0, flail: 0 },
      roll: { armL: [0.55, -2.1, 0.85, 0.9], armR: [0.55, -2.1, 0.85, 0.9], legL: [0.45, -2.5, 0.6, 0.85], legR: [0.45, -2.5, 0.6, 0.85], lean: 0, look: 0.3, spin: 1, flail: 0 },
      tuck: { armL: [0.35, -1.9, 0.9, 0.9], armR: [0.35, -1.9, 0.9, 0.9], legL: [0.3, -2.6, 0.45, 0.95], legR: [0.3, -2.6, 0.45, 0.95], lean: -0.1, look: -0.5, spin: 0, flail: 0 },
      fall: { armL: [2.5, 0.7, 1, 1], armR: [2.2, 0.5, 1, 1], legL: [0.6, -0.8, 1, 0.9], legR: [0.3, -0.4, 1, 1], lean: -0.15, look: -0.6, spin: 0, flail: 1 },
    },
    tricks: ['roll', 'tuck', 'glide'],
  },
  keys: {
    KeyQ: ['L', 'hi'], KeyA: ['L', 'mid'], KeyZ: ['L', 'lo'],
    KeyE: ['R', 'hi'], KeyD: ['R', 'mid'], KeyC: ['R', 'lo'],
  },
});
