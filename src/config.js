const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const CFG = deepFreeze({
  maxDt: 0.05,
  // physics: cannon-es (vendor/cannon-es.js), SI units (m, s, kg)
  physicsStep: 1 / 120, // fixed step: each frame runs whole steps off an accumulator, so a dt sequence replays exactly
  gravity: 9.81,
  heroMass: 70,
  inertiaFloor: 0.005, // kg m^2: light segments (hands, feet, forearms) get at least this rotational inertia (ragdoll.js)
  // ragdoll muscles (ragdoll.js, velocity servos in the solver): per segment [rate 1/s, torque cap N m]: the pose error
  // closes at this rate under any load up to the cap. The trunk is near-rigid; the limbs give only on impacts.
  muscle: {
    chest: [30, 900], head: [24, 200], upperArm: [32, 260], forearm: [32, 160], hand: [24, 40],
    thigh: [22, 600], shin: [22, 400], foot: [18, 80],
    root: [5, 120], rootFirm: [12, 1500], // the pelvis upright reference: soft in flight, firm on walls/roofs/landing
  },
  webShoulder: { x: 0.2, y: 0.45 }, // m: webs leave from the core's shoulder on the shooting side (game.js aim)
  heroRadius: 0.5, // the core sphere (player.js): the gameplay body, at the pelvis
  soleDrop: 1.0, // m from the core (pelvis) down to the soles in flight
  landingGap: 0.5, // the hero landing starts with the core this far above resting on the street (his soles touch it)
  // the ragdoll follower (rig.js)
  rig: {
    iterations: 12, followOmega: 22, followMax: 450, liftSec: .15,
    standY: .96, wallStance: .78, perchY: .5, // pelvis height on a roof, pelvis distance off a wall face
    gripReach: .86, gripK: 2500, gripC: 70, gripMax: 400, // the hands on the rope line (above the pelvis toward the pivot)
  },
  roofRunSpeed: 8, // m/s: landed on a roof without a rope, the hero runs forward and drops off the edge
  airDrag: 0.007, // 1/m: quadratic drag, a = airDrag * v^2; terminal speed sqrt(g / airDrag) = 37 m/s (was 0.003: too fast overall)
  heroFriction: 0.05, // grazing a facade costs ~10% of the speed (was 0: walls felt like ice; 0.25 cost ~45% per graze)
  heroRestitution: 0.2,
  bounceMinSpeed: 4, // m/s impact speed along the contact normal that counts as a 'bounce' (camera shake)
  corridorHalfWidth: 14, // tower faces line x = +-14 (the street corridor)
  viewDistance: 300, // structures exist this far ahead of the hero (along the current street)
  // city grid (world.js): streets along z (at x = colX(i)) and along x (at z = rowZ(j)), corridorHalfWidth wide
  blockLen: 160, // mean distance between intersections..
  blockJitter: 20, // ..each street line moved by up to this, so neighbouring lines are 120-200 m apart
  rowOffset: 120, // row 0 sits 100-140 m ahead of the start (row -1 ends behind it): the hero starts mid-block
  cornerDepth: [34, 42], // every block corner holds a tall solid tower this many metres along each street (>= level.depth max,
  // so lots of the two streets meeting at a corner never overlap behind it)
  streetMargin: 1, // m: the hero's centre may leave the street corridors by this much (over a roof edge), no more
  crossIntersections: 2, // cross streets are built at this many intersections ahead
  turnShare: 0.6, // inside an intersection, horizontal velocity more than this along the cross street = turned
  turnInset: 3, // m: ..counted only this far inside the intersection square (at its edge he'd turn into the corner tower)
  turnReach: 14, // bot: a turning web lands at most this far short of the corner's edge
  behindDistance: 40, // and are removed this far behind
  startHeight: 94, // (the mid-air start of the test courses; the game starts on world.startTower)
  startRise: 6, // m: the start tower's roof over the tallest roof near the start (world.startTower)
  startDepth: 22, // m: the start tower's depth along the street, behind z = -2
  startSpeed: 12, // m/s forward at the start: a gentle leap, not a launch
  baseSpeed: 22, // render speed-feel reference only (fov and speed lines start here)
  maxSpeed: 60, // render speed-feel reference only (fov and speed lines are full here)
  aimAhead: 40, // m: every web meets its side's corridor face this far ahead of the hero (from the centre: yaw 19 deg)
  // High webs, as real swinging does: the rope is mostly up and forward, so its sideways pull is small next to the
  // forward momentum and the pendulum's low point (under the anchor, at the wall) is never reached before the release.
  // From the centre (42.4 m out to the face): hi rises 50 m (rope 12 deg out of the forward-vertical plane),
  // mid 30 m (15 deg), lo 12 m (19 deg). (Was 52 m ahead, hi +13 m, mid level, lo -31 m: every swing ran into the wall.)
  aimPastCross: 6, // m: when that point is in an intersection, webs go this far past it instead (the far corner tower)
  aimUpDeg: { hi: 30, mid: 20, lo: 16 }, // W / middle hand zone (side 'C'): straight ahead along the street, steeply up
  aimPitchDeg: { hi: 49.7, mid: 35.3, lo: 15.8 },
  // body English while on the rope: the swinger leans and pulls to turn the swing plane toward the street heading
  steer: {
    turn: 0.6, // 1/s: turn rate per unit sin(angle off heading), applied perpendicular to the velocity (no work)
    damp: 0.4, // 1/s: lateral velocity damping (only ever removes energy)
    maxAccel: 2.5, // m/s^2 cap on the whole steering acceleration (muscle, not a motor)
  },
  webRange: 170, // from beside one wall reaches the far wall; long enough for the 1.7x city's high webs
  webSpeed: 300, // m/s: a 54 m web lands in 0.18 s; a miss shows at full range after 0.45 s
  reelSpeed: 6, // (was 8: the reel pumped speed too fast; 4 starved the bot of height) m/s the held rope shortens at full reel (a hand-over-hand pull; the constraint turns it into tension)
  reelAccel: 4, // m/s^2 the reel spins up at once the rope is taut, so it never jerks the hero
  reelMinFactor: 0.5, // the reel stops at this fraction of the attach length
  minRopeLen: 3,
  // zip (Space, or the hand pulled toward the body) = the slingshot: let go and launch (zip.js, player.launchZip)
  zipLaunch: 20, // m/s added along the heading tilted toward the rope (mass-weighted: every body gets it)
  zipRopeBias: 0.5, // normalized heading + bias * normalized rope; <= .5 bounds horizontal deflection to 30 degrees
  zipLaunchSteps: 3, // physics steps the delta-v is spread over
  zipCooldownSec: 0.6, // no second zip sooner
  moves: {
    blendSec: 0.16,
    landingLeadSec: 0.8,
    landingStiffSec: 0.18,
    landingSettleSec: 1,
    landingRootInertia: 0.4, // kg m^2: the landing's root muscle scale (in contact the pelvis no longer turns the whole rig)
    landingPelvisY: 0.45, // m: the hero landing holds the pelvis at kneeling height (one knee and one fist down)
    strainForce: 2400, // N: full strain, using the solved rope equation multiplier
    weights: {
      corkscrew: 1, frontHalfTwist: 1, layoutBackflip: 1, swanDive: 1.2,
      superheroDive: 1.2, splitKick: 1, tuckBurst: 1, thwip: 1.2,
      spreadEagle: 0.8, slingshotWhip: 1,
    },
  },
  // wall run: hitting a building's side face with speed toward it runs along it, then jumps off
  wallRunMinSpeed: 2.5, // m/s into the face (before the hit) that starts a run; slower is a plain bump
  wallRunSec: 2.2, // seconds, including the physical turn onto the facade
  wallRunGravity: 0.15, // fraction of gravity while running
  wallRunSkin: 0.15, // m: the core within heroRadius + this of a face counts as touching it
  wallRunMaxSink: 1, // m/s: a faster fall is cut to this when the run starts
  wallRunCooldownSec: 0.6,
  // the vertical wall run: a facade hit moving mostly UP (or reeling/zipping to a web high on that face)
  climb: { zipRise: 10, minUp: 4, upShare: 1, speed: 9, sec: 2.5, vaultBelow: .3, vaultUp: 6, vaultIn: 1.2, kickUp: 3, perchSec: .8 },
  roofIdleSec: 2, // s on a roof with no input: he slows and stands, looking at the skyline
  // the start: a head-first dive off the start roof's edge (m/s out along the street and up)
  dive: { out: 6, up: 1.5, botCatchY: 80, lean: .3 }, // lean: rad the body tips past the fall line (head first) // no new run this long after a wall jump
  wallJump: { out: 9, up: 6, fwd: 3 }, // m/s added at the end of a run: away from the wall, up, along the run
  ropeMaxForce: 3e4, // N, the rope's tension limit (70 kg at 40 m/s on a 30 m rope needs ~4 kN); under the ragdoll joints' 4e4, so a rope never tears a wrist apart
  ropeStiffness: 1e8, // cannon SPOOK constraint parameters for the rope
  ropeRelaxation: 2, // steps to correct a stretch: lower is stiffer (>= 1 stays stable)
  ropeWrapOffset: 0.08, // m: a wrap point sits this far outside the box edge it bends around
  ropeMaxWraps: 4, // more bends than this (or one that can't be placed) snaps the rope
  missShowSec: 0.25,
  // level generator (world.js); z is distance along the course
  level: {
    startZ: -20,
    easyZ: 400, // easy course before the difficulty ramp starts
    rampZ: 4000, // metres from easiest to hardest
    goodH: 120, // a tower on the corridor face at least this tall is a "sure anchor" (a mid web from flight height ~80 m lands on it)
    maxGapStart: 30, // longest z stretch with no sure anchor on either side, early..
    maxGapEnd: 70, // ..and late (a release at ~25 m/s carries > 100 m, so 70 m stays flyable)
    alleyStart: [0, 0.8], // empty z between lots: early seams are narrower than the hero (1 m), later alleys he can fall into
    alleyEnd: [2, 12],
    towerLen: [24, 70],
    towerHStart: [170, 272], // 1.7x the forward-swing city ([100, 160]): hi from the 94 m start lands ~145 m up
    towerHEnd: [120, 289], // the low end stays >= goodH: every tower is a sure anchor ([70, 170] x 1.7)
    lowH: [20, 51], // low-rises (under archetypes.TALL_MIN)
    depth: [18, 34],
    sectionLen: [120, 320], // a stretch with buildings on both sides, or one side only
    oneSideStart: 0,
    oneSideEnd: 0.5,
    weightsStart: { tower: 1, low: 0, frame: 0, crane: 0, gap: 0 }, // lot kinds on a built-up side
    weightsEnd: { tower: 0.5, low: 0.15, frame: 0, crane: 0.2, gap: 0.15 }, // frame: hollow skeletons retired (terrace bands instead)
    offWeights: { low: 0.45, frame: 0, crane: 0.2, gap: 0.35 }, // the empty side of a one-side stretch
    setbackChance: 0.35,
    setbackInset: [4, 8],
    setbackH: [17, 68],
    ledgeChance: 0.3,
    bridgeStart: 0, // chance a new tower gets a skybridge to an overlapping tower across the street (none in the easy start)
    bridgeEnd: 0.3,
    bridgeY: [51, 119],
    frameLen: [20, 40],
    frameDepth: [12, 22],
    frameH: [30, 70],
    beam: 1.6, // frame post/beam thickness: > 3 physics steps of travel at top speed, so nothing tunnels
    gapLen: [15, 45],
    craneLot: 18,
    craneH: [71, 106], // jib height: a W web (aimUpDeg.mid) from flight height (~51 m and up) reaches it inside webRange
    craneReach: [20, 27], // the jib overhangs the street by this much: nearly across it, so a straight-ahead W web meets it
  },
  // game flow
  trickSec: 0.6,
  overInputDelaySec: 0.3, // ignore Space/Enter right after dying so a held key can't skip the result
  botWaitSec: 0.1, // ?autoplay and the headless bot test: free flight before the next press
  botReleaseClimb: 0.4, // let go past the swing bottom once climbing at 17 degrees (vel.y / speed), long before the anchor (was 0.6: held on until under the anchor, at the wall)..
  botStallSpeed: 6, // ..or once the swing has slowed below this
  botRopeMin: 20, // the bot skips ropes shorter (a wall it is next to) or longer (a slow, low swing) than these
  botRopeMax: 150,
  botTurnMinY: 28, // the turning bot (?autoturn) only webs a corner from at least this high..
  botTurnMaxSink: 6, // ..and falling no faster than this (m/s): a long rope from a dive bottoms out near the street
  // camera
  camNear: 0.5,
  camBack: 8.5,
  camUp: 2.2,
  camFollow: 12, // 1/s, exponential smoothing rate (every axis also leads by vel / camFollow, so no steady lag)
  camTurnFollow: 6, // 1/s, the camera's yaw eases toward the street heading..
  camTurnRate: 120, // ..no faster than this many degrees per second
  camLeash: 1.25, // the camera is never farther from the hero than this x its desired offset (hero >= ~1/5 of the screen)
  fovMin: 62,
  fovMax: 92,
  fovFollow: 3,
  maxDpr: 2,
  // hand input
  handStableFrames: 2, // shoot gesture this many frames in a row = press (1 = fastest, but one bad frame fires a web)
  handReleaseFrames: 3, // non-shoot frames in a row = release (debounced: a flicker must not drop the rope)
  // finger bend = 3D angle MCP->PIP vs PIP->TIP in degrees (0 straight, ~130 folded onto the palm)
  handStraightDeg: 30, // 'open': all four fingers bend below this
  handExtendDeg: 65, // (was 60: flat/turned hands read 'none') 'shoot': index and pinky bend below this ...
  handCurlDeg: 40, // ... and middle and ring bend above this (half-curled still counts)
  handFistDeg: 90, // 'fist': all four bend above this
  handHoldSlackDeg: 35, // while holding a web, index/pinky may bend this much past handExtendDeg before it lets go
  handHystDeg: 10, // the gesture held last frame gets its thresholds loosened by this much
  handMinConfidence: 0.35, // MediaPipe detection / presence / tracking confidence (default 0.5)
  handLostMs: 300, // hand unseen this long while charging = cancel
  handSideCuts: [1 / 3, 2 / 3], // palm-centre x in the mirrored preview: left third 'L', middle 'C' (W), right 'R'
  handLevelCuts: [1 / 3, 2 / 3], // palm-centre y (0 = top) below these: hi, mid; else lo
  handPromptTimeoutSec: 15, // camera permission prompt nobody answers = give up (hand 'failed', H retries)
  handRestartSec: 1, // open palm held this long on title/result = start
  handZipShrink: 0.18, // shoot pose held and the hand's apparent size (wrist -> middle MCP) drops this much..
  handZipWindowMs: 250, // ..within this window = pulled toward the body = zip
  handZipCooldownMs: 600, // one zip per pull (= zipCooldownSec); the HUD shows 당기기! this long
  handMatchMaxDist: 0.2, // wrist moved farther than this (screen fraction) between frames = a different hand
  // render
  render: {
    // camera (the top-level cam*/fov* keys were the old canvas camera's; three.js uses these)
    camBack: 5, // m behind the hero: the ~1.8 m hero is ~1/4 of the screen at fovMin
    camUp: 1.4,
    lookAhead: 0.12, // s: the camera looks at pos + vel * lookAhead
    lookUp: 0, // m above the hero the look point sits (higher puts him low in the frame)
    camAttachDrop: 2.4, // m: on a rope with a high anchor the camera sinks this much (to ~1 m below him)..
    diveVy: [8, 16], diveUp: 3, diveLookDown: 10, // falling from height: rises behind him, looks down the fall line
    airVy: 5, airBack: .5, airSec: 3, // (only in the flight after a release) // big air near an apex: pulled back up to 1.5x (the hero >= 1/8 of the screen)
    edgeUp: 2.5, edgeLookDown: 14, edgeLookAhead: 12, // on the start roof's edge: above behind him, down at the city
    climbOut: 6, climbBelow: 2.5, climbLookUp: 4, // a climb up a facade: below him, out from the glass, looking up it
    camAttachLift: 1.8, // m: ..and its look point rises this much: it looks ~22 deg up, the anchor's splat in frame
    landDip: 0.6, // m: the camera dips at the hero landing's impact..
    landDipSec: 0.45, // ..and comes back up over this
    dustSec: 1.2, // the landing's dust ring and puffs
    lookMaxSide: 1.2, // m: cap on the look point's lead sideways and up/down
    camWallGap: 1.5, // m: at the corridor face the camera sits this far toward the street from the hero
    camBoxMargin: 0.3, // m: the camera never gets closer than this to a structure box
    camSnap: 80, // m: a bigger jump (restart) snaps the camera instead of easing
    fovMin: 60, // a normal lens: anchors ~52 m ahead are already in view looking forward
    fovMax: 68, // only a slight widening with speed; more reads as fisheye distortion
    trimProud: 0.04, // m: cornices, slabs and plates stand this far off the faces they wrap (never coplanar: no z-fighting)
    decalLift: 0.035, // m: planes on a face (web splat, clock dial, signs and ads) sit this far off it
    near: 0.3, // (was 0.1: depth precision; the camera never comes closer than ~1 m to a surface)
    far: 2700, // the 1.7x skyline (spires to ~560 m) stays inside the frustum
    fogDensity: 0.0037, // exp2: ~65% hazed at the 300 m spawn horizon, opaque by ~500 m; tall tops show through the haze
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
    blue: '#183a7a',
  },
  keys: {
    KeyQ: ['L', 'hi'], KeyA: ['L', 'mid'], KeyZ: ['L', 'lo'],
    KeyE: ['R', 'hi'], KeyD: ['R', 'mid'], KeyC: ['R', 'lo'],
    KeyW: ['C', 'mid'], // straight ahead and up: overhead cranes and skybridges
  },
  zipKey: 'Space', // pressed during play = the slingshot zip (on the title/result it starts the game)
});
