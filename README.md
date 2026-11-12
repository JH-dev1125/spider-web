# Web Runner

빌딩 사이를 줄(웹)로 스윙하며 달리는 브라우저 게임. 설치·빌드 없이 파일만 열면 돌아간다.

## 1. 실행

```
python -m http.server 8000
```

브라우저에서 `http://localhost:8000` 접속. (`index.html`을 더블클릭하면 모듈이 막혀서 안 돌아가니 꼭 서버로 연다.)

## 2. 조작

키보드 (왼쪽 / 오른쪽 벽의 위·가운데·아래로 줄을 쏜다)

| | 위 | 가운데 | 아래 |
|---|---|---|---|
| 왼쪽 | Q | A | Z |
| 오른쪽 | E | D | C |

- 누르면 즉시 거미줄 → 누르고 있는 동안 스윙 → 떼면 날아감.
- 물리 엔진(cannon-es)으로 움직인다. 떼는 순간의 속도가 그대로 유지되니, 최저점을 지나 위로 올라갈 때 떼면 멀리 날아간다.
- 너무 오래 잡고 있으면 진자처럼 뒤로 되돌아간다.
- Space / Enter: 시작, 죽은 뒤 다시 하기.

웹캠 손동작 (제목 화면에서 `H`로 켠다. 키보드도 같이 동작)

- 발사 자세: 검지와 새끼손가락을 펴고, 중지와 약지는 접는다.
- 손이 화면의 왼쪽 절반이면 왼쪽, 오른쪽 절반이면 오른쪽.
- 손 높이(위/가운데/아래 세 구간)로 줄을 쏘는 높이를 고른다.
- 검지·새끼 펴면 발사, 유지하면 스윙, 풀면 날아감.
- 손바닥을 펴고 1초 유지하면 시작 / 다시 하기.

웹캠은 HTTPS 또는 localhost에서만 동작한다. 영상은 이 PC 안에서만 처리되고 밖으로 나가지 않는다.

## 3. 배포 (GitHub Pages)

1. GitHub에서 빈 저장소를 만든다.
2. 이 폴더에서:
   ```
   git remote add origin https://github.com/<아이디>/<저장소>.git
   git push -u origin main
   ```
3. 저장소 Settings → Pages → Source: Deploy from a branch → Branch `main`, `/ (root)` → Save.
4. 1~2분 뒤 친구에게 줄 주소: `https://<아이디>.github.io/<저장소>/`

Pages는 HTTPS라서 친구들도 웹캠 손동작을 쓸 수 있다.

## 4. 손동작 시험판

`/spike/hand.html` (로컬이면 `http://localhost:8000/spike/hand.html`). 웹캠 손 인식이 내 환경에서 잘 되는지 따로 확인하는 페이지.

## 5. 테스트

```
node --test tests/*.test.js
```

Node 22.15 이상 필요. (`npm test`도 같은 명령)

## 6. 수정 가이드

| 바꾸고 싶은 것 | 파일 |
|---|---|
| 속도·중력·줄 길이·난이도 등 모든 숫자, 색, 키 배치 | `src/config.js` |
| 캐릭터 모양·포즈 | `src/character.js` |
| 빌딩·배경 그리기, 카메라 | `src/render.js` |
| 줄 조준 / 물리 엔진 연동(줄·충돌) | `src/web.js` / `src/player.js` (엔진: `vendor/cannon-es.js`) |
| 빌딩·구조물 생성(난이도, 막힌 구간 방지) | `src/world.js` |
| 점수 | `src/score.js` |
| 줄 발사, 포즈, 죽을 때 추락 | `src/game.js` |
| 키보드·손 입력 공통 충전 처리 / 키 입력 | `src/input-core.js`, `src/keyboard.js` |
| 제목·결과 화면 글자 | `src/main.js` |
| 손동작 판별 | `src/hand-classify.js`, `src/hand.js` |
