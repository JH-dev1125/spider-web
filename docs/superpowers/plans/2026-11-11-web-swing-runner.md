# 웹스윙 러너 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 등 뒤 시점 2.5D 무한 웹스윙 브라우저 게임(키보드 + 웹캠 손동작)을 GitHub Pages로 배포 가능하게 만든다.

**Architecture:** 빌드 없는 ES 모듈. 게임 로직(world/web/player/input-core/score)은 DOM을 모르는 순수 모듈이라 Node 내장 테스트로 검증한다. 그리기(render/character)와 장치(keyboard/hand)는 얇게 유지하고 `main.js`가 묶는다. 모든 수치는 `src/config.js`.

**Tech Stack:** HTML, JavaScript ES2022 모듈, Canvas 2D, MediaPipe Tasks Vision(CDN, `@mediapipe/tasks-vision@0.10.14`), 테스트는 `node --test` (Node 24, npm 패키지 없음).

**Spec:** `docs/superpowers/specs/2026-11-11-web-swing-runner-design.md` (8.5절 결정 포함 — 반드시 읽을 것)

## Global Constraints

- npm 의존성·번들러·게임 엔진 금지. 외부 로드는 MediaPipe CDN 하나뿐(`src/hand.js`에서만).
- 이미지 파일 0개. 모든 그래픽은 코드로 그림.
- 자체 코드·에셋 합계 < 1MB.
- 순수 로직 모듈(`config, world, web, player, input-core, score, hand-classify`)은 `window`/`document`를 참조하지 않는다.
- 수치 상수는 `src/config.js`의 `CFG`에만. 다른 파일에 매직 넘버 금지(0, 1, ±1, 0.5 제외).
- 좌표: x 좌우(왼쪽 −), y 높이(위 +, 바닥 y=0), z 전진. 단위 = 미터.
- 키 배치: 왼 상·중·하 `KeyQ`·`KeyA`·`KeyZ`, 오 상·중·하 `KeyE`·`KeyD`·`KeyC`. 재시작 `Space`/`Enter`.
- 캐릭터는 오리지널(가칭 "웹러너", 빨강/검정 가면). 마블 명칭·로고 사용 금지.
- 테스트 명령: `node --test tests/` 전부 통과해야 커밋.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. 탭을 숨겼다 돌아오면 dt가 몇 초로 튐 → 프레임 dt는 `CFG.maxDt`(0.05)로 잘라 캐릭터가 순간 추락하지 않아야 함. (Task 4 테스트)
2. 두 방향 키를 동시에 누름 → 마지막으로 누른 방향이 조준, 그 키를 떼면 발사, 먼저 누른 키를 떼는 건 무시. (Task 5 테스트)
3. 사망 순간 키를 누르고 있다가 재시작 → 이전 판의 충전이 새 판에서 발사되면 안 됨(`tracker.cancel()`). (Task 7)
4. 웹캠 거부/미지원/CDN 로드 실패 → 에러 없이 키보드 모드로 진행하고 화면에 한 줄 안내. (Task 8)
5. `localStorage` 접근이 예외를 던짐(사생활 보호 모드) → 최고 점수는 메모리로만 유지하고 게임은 계속. (Task 7 테스트)

---

### Task 1: 뼈대 · 설정 · 테스트 러너

**Files:**
- Create: `.gitignore` (`.superpowers/`, `node_modules/`), `index.html`, `src/config.js`, `src/main.js`, `tests/config.test.js`, `README.md`(실행법 3줄: `python -m http.server 8000` → `http://localhost:8000`, 테스트 `node --test tests/`)
- `package.json`: `{"type":"module","private":true}` 한 줄짜리만 (Node가 ESM으로 읽게. 의존성 없음)

**Interfaces:**
- Produces: `export const CFG` — 최소 키: `maxDt:0.05, gravity:18, corridorHalfWidth:14, viewDistance:260, behindDistance:40, startHeight:45, ceiling:140, baseSpeed:22, maxSpeed:60, speedRampPerSec:0.25, easySeconds:20, chargeMin:12, chargeMax:70, chargeFullSec:1.0, reelFactor:0.85, releaseBoostUp:6, releaseBoostForward:4, wallBounceLoss:0.5, autoReleaseBackAngleDeg:35, missShowSec:0.25, keys:{KeyQ:['L','hi'],KeyA:['L','mid'],KeyZ:['L','lo'],KeyE:['R','hi'],KeyD:['R','mid'],KeyC:['R','lo']}`. 이후 Task가 키를 추가해도 됨.
- `index.html`: 전체화면 `<canvas id="game">`, `<video id="cam" playsinline hidden>`, `<script type="module" src="src/main.js">`.
- `main.js`(이 Task에서는): canvas 리사이즈 + `requestAnimationFrame` 루프에서 하늘색 그라데이션만 그림.

- [ ] **Step 1:** `git init`, `.gitignore`, `package.json`.
- [ ] **Step 2: 실패 테스트** `tests/config.test.js` — `CFG.keys`가 정확히 6개 키, 값이 `side∈{L,R}`·`level∈{hi,mid,lo}`의 6조합을 중복 없이 덮음; `CFG.chargeMin < CFG.chargeMax`; `Object.isFrozen(CFG)`.
- [ ] **Step 3:** `node --test tests/` → FAIL(모듈 없음).
- [ ] **Step 4:** `config.js`(깊은 freeze), `index.html`, `main.js` 작성.
- [ ] **Step 5:** `node --test tests/` → PASS. `python -m http.server 8000`으로 열어 그라데이션 확인.
- [ ] **Step 6:** 커밋 `chore: scaffold web-swing runner` (spec·plan 문서도 함께 add).

### Task 2: 월드 — 건물 생성과 난이도

**Files:** Create `src/world.js`, `tests/world.test.js`

**Interfaces:**
- Consumes: `CFG`
- Produces:
  - `makeRng(seed:number) -> () => number` (mulberry32, [0,1))
  - `difficulty(elapsedSec:number) -> {speed, gapMin, gapMax, lenMin, lenMax, hMin, hMax}`
  - `createWorld(rng) -> {buildings: Building[], nextZ:{L:number, R:number}}`
  - `updateWorld(world, playerZ:number, elapsedSec:number, rng) -> void` — 양쪽 각각 `nextZ < playerZ + CFG.viewDistance`인 동안 건물 추가, `z1 < playerZ - CFG.behindDistance`인 건물 제거.
  - `Building = {side:'L'|'R', z0:number, z1:number, h:number}`; 면은 평면 `x = (side==='L'?-1:1) * CFG.corridorHalfWidth`, y∈[0,h], z∈[z0,z1].

- [ ] **Step 1: 실패 테스트** — (a) `difficulty(0)`와 `difficulty(CFG.easySeconds)`는 `speed===CFG.baseSpeed`; `difficulty(300).speed > difficulty(60).speed`, `<= CFG.maxSpeed`; `gapMax`도 단조 비감소. (b) 같은 seed → 같은 건물 목록. (c) `updateWorld` 후 각 side에서 z 순서대로 건물이 겹치지 않고, 인접 간격 ∈ [gapMin, gapMax]; 최소 한 건물은 `h > CFG.startHeight`. (d) playerZ를 1000 전진시키면 남은 건물 전부 `z1 >= playerZ - behindDistance`, 배열 길이가 무한히 늘지 않음(< 200). (e) 시작 구간: `createWorld` 직후 `updateWorld(w,0,0,rng)`에서 z∈[0,40]에 양쪽 모두 건물이 있음(첫 거미줄 보장).
- [ ] **Step 2:** FAIL 확인.
- [ ] **Step 3:** 구현. 난이도는 `easySeconds` 이후 선형 증가, 상한 clamp. `hMin`은 대략 `startHeight*0.8`, `hMax`는 `ceiling*0.9` 근처에서 시작해 편차 증가(값은 config에 추가).
- [ ] **Step 4:** PASS. **Step 5:** 커밋 `feat: infinite building generation with difficulty curve`.

### Task 3: 거미줄 — 조준·충전·광선 충돌

**Files:** Create `src/web.js`, `tests/web.test.js`

**Interfaces:**
- Consumes: `CFG`, `Building`
- Produces:
  - `aimVector(side:'L'|'R', level:'hi'|'mid'|'lo') -> {x,y,z}` 단위벡터. x 부호 = side, z > 0 항상(앞으로 기울어짐), y: hi>0, mid≈0(|y|<0.15), lo<0. 각도는 config(`aimYawDeg`, `aimPitchDeg:{hi,mid,lo}`).
  - `chargeLength(heldSec:number) -> number` — 0 → `chargeMin`, `≥chargeFullSec` → `chargeMax`, 선형, 음수는 0 취급.
  - `castWeb(origin:{x,y,z}, dir:{x,y,z}, length:number, buildings:Building[]) -> {x,y,z}|null` — 광선이 길이 안에서 처음 만나는 건물 면(위 평면 정의, y∈[0,h], z∈[z0,z1]) 교점. 반대쪽 side 건물은 무시. 없으면 null.

- [ ] **Step 1: 실패 테스트** — 6조합 aimVector 부호 규칙 + 길이 1(±1e-9). `chargeLength(0)===chargeMin`, `(0.5)`는 중간값, `(5)===chargeMax`, `(-1)===chargeMin`. castWeb: origin `{0,40,0}`, 오른쪽 mid, 건물 `{side:'R',z0:5,z1:30,h:80}` → 교점 x===corridorHalfWidth, z∈[5,30]; 같은 경우 length 5 → null(못 미침); 건물 h:10(교점 y가 h 위) → null; 왼쪽 건물만 있을 때 오른쪽 발사 → null; 앞뒤 두 건물 중 가까운 쪽 교점 반환.
- [ ] **Step 2:** FAIL. **Step 3:** 구현(평면 x=const 교차: `t=(xFace-ox)/dx`, `t>0 && t<=length`). **Step 4:** PASS. **Step 5:** 커밋 `feat: six-direction web aiming and raycast`.

### Task 4: 플레이어 물리 — 스윙·해제·벽·사망

**Files:** Create `src/player.js`, `tests/player.test.js`

**Interfaces:**
- Consumes: `CFG`, `Building`
- Produces:
  - `createPlayer() -> Player`; `Player = {pos:{x,y,z}, vel:{x,y,z}, anchor:{x,y,z}|null, ropeLen:number, swingPhase:'none'|'descending'|'ascending', alive:boolean}`. 시작: pos `{0, startHeight, 0}`, vel `{0,0,baseSpeed}`.
  - `attach(p, point) -> void` — anchor 설정, `ropeLen = dist(pos,point) * CFG.reelFactor`, swingPhase `'descending'`.
  - `detach(p) -> void`
  - `stepPlayer(p, dt, buildings, minForwardSpeed) -> string[]` 이벤트(`'released'`, `'bounce'`, `'dead'`). dt는 내부에서 `min(dt, CFG.maxDt)`.
- 알고리즘(테스트가 정하지 않는 부분):
  ```
  vel.y -= gravity*dt; pos += vel*dt
  if anchor: d = pos-anchor; if |d| > ropeLen: pos = anchor + d/|d|*ropeLen; vel -= (vel·n)n (n=d/|d|, 바깥쪽 성분만 제거)
     phase: descending → pos.y가 최저점을 지나 vel.y>0 이면 ascending
     ascending 이고 (vel.y <= 0  또는 앵커가 캐릭터 기준 뒤쪽으로 autoReleaseBackAngleDeg 넘음) → detach, vel.y+=releaseBoostUp, vel.z+=releaseBoostForward, 'released'
  vel.z = max(vel.z, minForwardSpeed)
  |pos.x| >= corridorHalfWidth 이고 그 z에 같은 side 건물이 있고 pos.y < h → pos.x 안쪽으로 되돌림, vel.x = -vel.x*wallBounceLoss, 'bounce'
  건물 없는 곳이면 pos.x clamp(±corridorHalfWidth)
  pos.y > ceiling → pos.y=ceiling, vel.y=min(vel.y,0)
  pos.y <= 0 → alive=false, 'dead'
  ```

- [ ] **Step 1: 실패 테스트** — (a) 앵커 없이 반복 step → 결국 `'dead'`, y 단조 감소 후. (b) `stepPlayer(p, 5, ...)` 한 번 → y 감소량 ≤ `0.5*gravity*maxDt^2 + |vy|*maxDt + 1e-6`(dt clamp). (c) 오른쪽 위 앞 앵커에 attach 후 3초 step: 매 프레임 `dist(pos,anchor) <= ropeLen+1e-6`; 언젠가 `'released'` 발생, 그 후 anchor null. (d) 같은 출발 조건에서 스윙 한 번 탄 경우의 해제 직후 y가 앵커 없이 같은 시간 낙하한 y보다 큼(고도 회복, 루프 A). (e) 오른쪽 벽 건물 h 80 옆에서 vel.x=+30 → `'bounce'`, 이후 `|pos.x| < corridorHalfWidth`, `vel.x < 0`, alive 유지. (f) vel.z는 항상 ≥ minForwardSpeed. (g) vel.y=+100 → y ≤ ceiling.
- [ ] **Step 2:** FAIL. **Step 3:** 구현. **Step 4:** PASS(필요하면 config의 reel/boost 수치를 조정해 (d) 만족). **Step 5:** 커밋 `feat: pendulum swing physics with auto-release`.

### Task 5: 입력 코어와 키보드

**Files:** Create `src/input-core.js`, `src/keyboard.js`, `tests/input-core.test.js`

**Interfaces:**
- Produces:
  - `createChargeTracker() -> Tracker`:
    - `press(side, level, t)` — 조준 시작/교체, 충전 시작 시각은 첫 press 기준 유지하지 않고 **교체 시 재시작**.
    - `move(side, level)` — 충전 유지한 채 방향만 갱신(손 모드용).
    - `release(side, level, t) -> {side, level, heldSec}|null` — 현재 조준이 (side,level)과 같을 때만 발사 반환, 아니면 null. 키보드에서 `release(..)`에 인자 없이 `release(null,null,t)`면 현재 조준 그대로 발사(손 모드용).
    - `cancel()`
    - `state(t) -> {side, level, heldSec}|null` — 조준선 미리보기용.
  - `attachKeyboard(target:EventTarget, tracker, now:()=>number) -> () => void`(해제 함수). `keydown`의 `e.repeat` 무시, `CFG.keys[e.code]`만 처리.

- [ ] **Step 1: 실패 테스트**(tracker만, Node) — press(R,hi,0) → state(0.4).heldSec≈0.4; release(R,hi,0.4) → `{side:'R',level:'hi',heldSec:0.4}`; 이후 state null. 동시 입력: press(L,mid,0), press(R,lo,0.2), release(L,mid,0.3) → null 이고 state 여전히 R/lo; release(R,lo,0.5) → heldSec 0.3. move(L,hi) 후 release(null,null,t) → side L level hi. cancel 후 release → null.
- [ ] **Step 2:** FAIL. **Step 3:** 구현. **Step 4:** PASS. **Step 5:** 커밋 `feat: charge tracker and keyboard input`.

### Task 6: 렌더링 — 카메라·도시·속도감·캐릭터

**Files:** Create `src/render.js`, `src/character.js`, `tests/render.test.js`

**Interfaces:**
- Consumes: `Player`, `Building`, tracker `state()` 결과, `aimVector`, `chargeLength`
- Produces:
  - `project(pt:{x,y,z}, cam:{x,y,z,fovDeg}, w, h) -> {sx, sy, scale}|null` — 카메라는 +z를 봄; `pt.z - cam.z <= near(CFG.camNear)` 이면 null. scale = 초점거리/깊이.
  - `makeCamera(player, prevCam|null, dt) -> cam` — 캐릭터 뒤(`camBack`)·위(`camUp`), x는 지수 스무딩으로 따라감, fovDeg는 속도에 비례해 `fovMin`→`fovMax`.
  - `drawFrame(ctx, w, h, view)`; `view = {player, buildings, cam, aim:{side,level,heldSec}|null, missLine:{to,age}|null, pose, t, shake}`. 그리는 순서: 하늘 그라데이션 → 원경 실루엣 2~3겹(cam.z에 패럴랙스, 결정론적 의사난수로 무한 반복) → 바닥(y=0 평면, 거리 불빛 점) → 건물(먼 것부터, 측면 사각형 + 창문 격자 몇 줄) → 거미줄 선 → 조준 미리보기 점선(`aimVector*chargeLength(heldSec)`) → 캐릭터 → 속도선(속도 ≥ baseSpeed*1.3부터, 가장자리에서 중앙 방향).
  - `character.js`: `drawCharacter(ctx, sx, sy, scale, pose:'swing'|'glide'|'roll'|'tuck'|'fall', t)` — 빨강/검정 실루엣, roll은 t로 회전, tuck은 무릎 접음. 교체 지점이므로 이 함수 시그니처만 외부에 노출.
  - `pickTrickPose(rng) -> 'roll'|'tuck'|'glide'` (render.js 또는 character.js, 순수).

- [ ] **Step 1: 실패 테스트**(project, makeCamera만) — 카메라 정면 점은 화면 중앙(w/2, h/2 근처); 더 먼 점은 scale 작음; 오른쪽 x 점은 sx > w/2; 위쪽 y 점은 sy < 카메라 높이 점의 sy; 카메라 뒤 점 null. makeCamera: 속도 높을수록 fov 큼, ≤fovMax.
- [ ] **Step 2:** FAIL. **Step 3:** 구현. **Step 4:** PASS.
- [ ] **Step 5: 시각 확인** — 임시로 `main.js`에서 정지 상태 player + `createWorld` 건물을 그려 브라우저에서 도시·캐릭터 5포즈가 보이는지 확인(포즈는 숫자키 1~5 디버그 토글, 이 Task 이후 제거해도 됨).
- [ ] **Step 6:** 커밋 `feat: perspective renderer, city backdrop, character poses`.

### Task 7: 게임 흐름 · 점수 · 연결

**Files:** Create `src/score.js`, `tests/score.test.js`; Modify `src/main.js`

**Interfaces:**
- Consumes: 위 전부
- Produces:
  - `createScore(storage) -> {best():number, submit(distance:number):boolean}` — 키 `'webrunner.best'`. storage 메서드가 throw하면 메모리 값으로 동작. `submit`은 새 최고면 저장하고 true. **(추후 순위표 연결 지점: 이 함수만 바꾸면 됨)**
  - `main.js` 상태 머신: `'title' | 'play' | 'over'`.
    - title: 제목 "WEB RUNNER", 조작법(Q/A/Z · E/D/C, 길게 누를수록 멀리), "Space: 키보드로 시작", "H: 손동작 켜기"(Task 8에서 동작). 
    - play: 매 프레임 `dt=min(dt,CFG.maxDt)`; difficulty → updateWorld → 발사 이벤트면 `castWeb(player.pos, aimVector, chargeLength(heldSec), buildings)` → 성공 attach / 실패 missLine; `stepPlayer(p, dt, buildings, diff.speed)`; `'released'` 이벤트마다 `pickTrickPose`로 포즈 0.6초; 앵커 있으면 'swing', 없으면 'glide'(트릭 중 제외); `'dead'` → over.
    - over: 낙하 연출 1초 후 점수·최고 점수·"NEW BEST" 표시, Space/Enter로 재시작. 진입 시 `tracker.cancel()`, 재시작 시에도 `cancel()`.
    - HUD: 상단 중앙 `"${Math.floor(player.pos.z)} m"`, 우상단 `BEST`.

- [ ] **Step 1: 실패 테스트** `score.test.js` — 가짜 Map 기반 storage로 best 0 → submit(100) true → best 100 → submit(50) false → 새 createScore가 100 읽음; getItem/setItem이 throw하는 storage에서도 submit(10) true, best 10, 예외 없음; 저장값이 `"abc"`면 best 0.
- [ ] **Step 2:** FAIL. **Step 3:** score.js 구현, main.js 연결. **Step 4:** `node --test tests/` PASS.
- [ ] **Step 5: 플레이 확인** — 브라우저에서: 시작 → Q/E로 스윙이 이어짐 → 아무것도 안 누르면 죽음 → 결과 화면 → 재시작. 사망 직전 E를 누른 채 재시작해도 첫 프레임에 발사 안 됨. 탭 전환 후 복귀해도 순간 사망 없음.
- [ ] **Step 6:** 커밋 `feat: game loop, scoring, title and game-over screens`.

### Task 8: 손동작 인식 + 시험판

**Files:** Create `src/hand-classify.js`, `src/hand.js`, `spike/hand.html`, `tests/hand-classify.test.js`; Modify `src/main.js`(H 키)

**Interfaces:**
- Consumes: Tracker(Task 5)
- Produces:
  - `classifyHand(landmarks:{x,y}[21], handedness:'Left'|'Right') -> {gesture:'shoot'|'fist'|'open'|'none', side:'L'|'R', level:'hi'|'mid'|'lo'}` — 순수. 손가락 펴짐 = 끝(tip) 마디가 PIP보다 손목에서 더 멂. shoot = 검지·새끼 펴짐 + 중지·약지 접힘(엄지 무시). fist = 네 손가락 접힘. open = 네 손가락 펴짐. side: 거울 화면 기준 손목 x < 0.5 → 'L'. level: 손목 y < 1/3 'hi', < 2/3 'mid', 그 외 'lo'.
  - `createGestureGate(frames:number) -> (g:string) => string` — 같은 제스처가 `frames`(CFG.handStableFrames=3)회 연속일 때만 바뀐 값을 반환(떨림 방지).
  - `startHand(video, tracker, now, opts={mode:'shoot'|'fist'}) -> Promise<{stop():void}>` — `getUserMedia` → MediaPipe `HandLandmarker`(VIDEO 모드, numHands 2, CDN `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14` 와 모델 `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`). 충전 제스처 진입 → `tracker.press`, 유지 중 위치 변화 → `tracker.move`, 제스처 해제 → `tracker.release(null,null,t)`, 손이 `CFG.handLostMs`(300) 이상 안 보임 → `tracker.cancel()`. 실패 시 reject.
- `main.js`: 타이틀에서 H → startHand; reject 시 "웹캠을 쓸 수 없어 키보드로 진행해" 한 줄 표시 후 키보드 모드. 플레이 중 우하단에 작은 웹캠 미리보기(거울) + 인식된 제스처 텍스트. over 화면에서 open 제스처 1초 유지 = 재시작.
- `spike/hand.html`: 웹캠 + 랜드마크 점 + 현재 gesture/side/level/heldSec 큰 글씨 + 6칸 그리드에 조준 칸 하이라이트 + 모드 토글(shoot/fist). **버리는 시험판**: 사용자가 조작감 판정.

- [ ] **Step 1: 실패 테스트** — 손으로 만든 합성 랜드마크 픽스처(펴진 손가락은 tip이 손목에서 멀게, 접힌 손가락은 가깝게)로 shoot/fist/open/none 판정; 손목 (0.2,0.1) → L/hi, (0.8,0.9) → R/lo; gate: `['shoot','shoot','none','shoot','shoot','shoot']` 순서 입력 시 3연속이 된 마지막에야 'shoot' 반환, 그 전엔 초기값 'none'.
- [ ] **Step 2:** FAIL. **Step 3:** 구현. **Step 4:** PASS.
- [ ] **Step 5:** `spike/hand.html`을 localhost에서 열어 웹캠 거부 시 에러 메시지, 허용 시 판정 표시 확인(가능한 범위에서; 실제 조작감 판정은 사용자 몫).
- [ ] **Step 6:** 커밋 `feat: webcam hand gesture control and spike page`.

### Task 9: 배포 마무리

**Files:** Modify `README.md`

- [ ] **Step 1:** README에 추가: 조작법, GitHub에 올리는 법(`git remote add origin …` → push → Settings → Pages → Branch `main` / root), 친구에게 줄 주소 형식 `https://<아이디>.github.io/<저장소>/`, 웹캠은 HTTPS(Pages)·localhost에서만 동작, 손동작 시험판 주소 `/spike/hand.html`.
- [ ] **Step 2:** 자체 코드 용량 확인: `du -sh src index.html` < 1MB. `grep -rn "Marvel\|Spider-Man\|스파이더맨" src index.html` → 0건.
- [ ] **Step 3:** `node --test tests/` PASS. 커밋 `docs: play and deploy instructions`.
