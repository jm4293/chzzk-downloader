# Chzzk VOD Downloader

치지직(Chzzk) VOD를 다운로드하는 로컬 웹앱. Node.js + Express 백엔드, 바닐라 HTML/JS 프론트엔드로 구성되어 있습니다.

---

## 실행

```bash
npm install
npm start
# → http://localhost:3000
```

---

## 폴더 구조

```
chzzk/
├── public/                 # 프론트엔드 (정적 파일)
│   ├── index.html          # UI 레이아웃
│   ├── style.css           # 스타일
│   └── app.js              # UI 로직 (API 호출, SSE, localStorage)
├── src/                    # 백엔드
│   ├── server.js           # Express 서버, API 라우팅, SSE
│   ├── chzzk-api.js        # 치지직 API와의 통신 (정보 조회, 화질 목록)
│   └── downloader.js       # 파일 다운로드, 오디오 추출 (ffmpeg)
├── downloads/              # 다운로드된 파일 저장 폴더 (자동 생성)
├── package.json
└── README.md
```

---

## 전체 흐름 한눈에 보기

```
[사용자 (브라우저)]
    │
    │  ① URL 입력 → "정보 조회" 클릭
    ▼
[app.js]  →  POST /api/info  →  [server.js]
                                    │
                                    ├─ extractVideoNo()        URL에서 숫자 ID 추출
                                    ├─ getVideoInfo()          치지직 API로 영상 메타데이터 조회
                                    └─ getQualities()          Playback API로 해상도별 URL 목록 조회
                                                               (라이브 다시보기는 m3u8 URL 반환)
                                    │
    ◄───────── JSON 응답 ──────────┘
    │  (제목, 채널명, 썸네일, 화질 목록)
    │
    │  ② 화질 선택 → "다운로드 시작" 클릭
    ▼
[app.js]  →  POST /api/download  →  [server.js]
                │                        │
                │  downloadId 반환        │ 백그라운드로 실행 시작
                │                        ├─ downloadHls()    HLS 세그먼트 병렬 다운로드 (일반 VOD)
                │                        │                   또는 m3u8 직접 처리 (라이브 다시보기)
                │                        ├─ downloadMp4()    직접 MP4 스트리밍 (폴백)
                │                        └─ extractAudio()   오디오만 체크시 ffmpeg로 M4A 추출
                │
                │  ③ SSE로 진행률 구독
                ▼
[app.js]  ←  GET /api/download/progress/:id  ←  [server.js]
              (실시간 percent 업데이트)
```

---

## 파일별 역할 상세

### `src/server.js` — Express 서버

백엔드의 중심. 네 가지 API를 제공합니다.

| 엔드포인트 | 메서드 | 역할 |
|---|---|---|
| `/api/info` | POST | URL을 받아 영상 정보와 화질 목록을 반환 |
| `/api/download` | POST | 다운로드를 백그라운드로 시작하고 `downloadId`를 반환 |
| `/api/download/progress/:id` | GET | SSE(Server-Sent Events)로 진행률을 실시간 스트리밍 |
| `/api/download/file/:filename` | GET | 완료된 파일을 클라이언트로 다운로드 제공 |

**SSE 진행률 구조:**

다운로드를 시작하면 즉시 `downloadId`를 반환하고, 백그라운드에서 실제 다운로드가 진행됩니다. 프론트엔드는 해당 `downloadId`로 SSE 엔드포인트에 연결하여 진행률을 실시간으로 받습니다.

```
POST /api/download  →  { downloadId: "abc-123" }  (즉시 반환)

GET /api/download/progress/abc-123  (SSE 연결)
  ← data: { "percent": 10 }
  ← data: { "percent": 25 }
  ...
  ← data: { "percent": 50, "status": "오디오 추출 중..." }  (audioOnly일 때)
  ...
  ← data: { "percent": 100, "done": true, "filename": "영상제목.mp4" }
```

`audioOnly`가 체크된 경우, 진행률은 다운로드 단계를 0~50%로 축소하고 추출 단계를 50~100%로 배분합니다.

---

### `src/chzzk-api.js` — 치지직 API 통신

치지직의 비공식 API와 대화하는 모듈입니다. 3개의 함수로 구성됩니다.

**`extractVideoNo(url)`**

URL 문자열에서 숫자 ID를 정규식으로 추출합니다.

```
https://chzzk.naver.com/video/11577750  →  "11577750"
```

**`getVideoInfo(videoNo, cookies)`**

치지직의 영상 정보 API를 호출합니다.

```
GET https://api.chzzk.naver.com/service/v2/videos/{videoNo}
→ 응답: { content: { videoTitle, videoId, inKey, adult, liveRewindPlaybackJson, ... } }
```

- `videoId`와 `inKey`는 일반 VOD의 Playback API 호출에 필요한 키입니다.
- 라이브 다시보기(Live Rewind)인 경우 `liveRewindPlaybackJson`을 파싱하여 반환합니다.
- 성인 콘텐츠의 경우, 로그인 쿠키가 없으면 `inKey`가 `null`로 반환됩니다.
- `cookies` 파라미터에 `NID_AUT`, `NID_SES`를 넘기면 로그인 상태로 API를 호출합니다.

**`getQualities(videoId, inKey, liveRewindPlayback)`**

영상 종류에 따라 두 가지 경로로 화질 목록을 반환합니다.

*라이브 다시보기인 경우:*

`liveRewindPlayback.media`에서 HLS 트랙을 추출합니다. 각 트랙은 m3u8 URL(`baseURL`)과 해상도, 비트레이트 정보를 포함하며, `isLiveRewind: true` 플래그가 표시됩니다.

*일반 VOD인 경우:*

Naver의 Playback API를 호출하여 해상도별 URL 목록을 반환합니다.

```
GET https://apis.naver.com/neonplayer/vodplay/v2/playback/{videoId}?key={inKey}
→ 응답 구조: period[] → adaptationSet[] → representation[]
```

응답 안에는 두 종류의 `adaptationSet`이 있습니다:

| mimeType | 내용 | 사용 여부 |
|---|---|---|
| `video/mp4` | 단일 파일로 직접 다운로드 가능한 MP4 | 폴백용 |
| `video/mp2t` | HLS 세그먼트 (TS 파일) | **기본 사용** |

두 종류 모두 반환되며, 프론트엔드(`app.js`)에서 동일 해상도일 때 **HLS를 우선** 선택합니다.

- `video/mp4`: `baseURL[0].value`가 직접 다운로드 URL
- `video/mp2t`: `segmentTemplate.media`에 세그먼트 URL 템플릿, `segmentTimeline`에서 총 세그먼트 수 포함

> 참고: URL에는 `_lsu_sa_` 파라미터가 포함되어 있어 일정 시간 후 만료됩니다. 정보 조회 후 빠르게 다운로드해야 합니다.

---

### `src/downloader.js` — 다운로드 및 오디오 추출

**`downloadHls(hls, title, onProgress)`** — 기본 다운로드 방식

두 가지 경로로 처리합니다.

- **라이브 다시보기** (`hls.isLiveRewind === true`): ffmpeg로 m3u8 URL을 직접 입력받아 다운로드합니다. stderr에서 `time=` 값을 파싱하여 진행률을 계산합니다.
- **일반 VOD HLS**: 세그먼트를 **8개씩 병렬로** 다운로드하고, 하나의 `.ts` 파일로 결합한 후 ffmpeg로 `.mp4`로 변환합니다. 세그먼트 완료 비율로 진행률을 계산합니다. CDN 직접 MP4보다 수십 배 빠릅니다 (직접 MP4는 CDN 스로틀링으로 극도히 느려짐).

**`downloadMp4(mp4Url, title, onProgress)`** — 폴백 다운로드

- `axios`로 MP4 URL을 스트리밍 다운로드합니다 (`responseType: "stream"`).
- `Content-Length` 헤더로 총 파일 크기를 파악하고, 진행률을 계산하여 `onProgress` 콜백으로 전달합니다.
- 30초 내에 새 데이터가 안 오면 스트림을 종료합니다 (CDN 스로틀링 대응).
- 실패 시 부분 파일을 자동으로 삭제합니다.

**`extractAudio(mp4Path)`**

- `ffmpeg-static`을 사용하여 MP4에서 오디오만 추출합니다.
- ffmpeg 옵션: `-vn` (비디오 제거), `-c:a copy` (오디오 재인코딩 없이 복사)
- 출력 형식: `.m4a` (AAC-LC)
- 추출 완료 후 소스 MP4 파일은 자동 삭제됩니다.

---

### `public/index.html` — UI 레이아웃

페이지의 구조를 정의합니다. 실제 표시/숨김 제어는 `app.js`가 `classList`를 통해 합니다.

| 섹션 | 역할 |
|---|---|
| `details#cookieDetails` | 성인 콘텐츠용 로그인 쿠키 입력 (기본 접힘) |
| `.input-group` | VOD URL 입력 + 정보 조회 버튼 |
| `#infoCard` | 영상 정보 카드 (썸네일, 제목, 채널, 재생시간) |
| `#qualitySection` | 화질 드롭다운 + 오디오만 체크박스 + 다운로드 버튼 |
| `#progressSection` | 진행률 바 |
| `#doneMsg` | 완료 메시지 |

---

### `public/app.js` — 프론트엔드 로직

전체가 IIFE(즉시실행함수)로 감싸져 있어 전역 변수가 생기지 않습니다.

**localStorage (쿠키 저장)**

- 키: `chzzk_cookies`
- 값: `{ NID_AUT: "...", NID_SES: "..." }`
- 페이지 로드 시 `loadCookies()`로 복원, input 변경 시 `saveCookies()`로 즉시 저장
- 둘 다 비우면 저장된 항목을 삭제하고 "저장됨" badge를 숨깁니다

**정보 조회 흐름**

1. URL과 쿠키를 수집
2. `POST /api/info`에 전송
3. 성인 콘텐츠(403)이면 쿠키 입력 섹션을 자동으로 열기
4. 성공 시 카드와 화질 옵션 표시 (동일 해상도에서 HLS를 mp4보다 우선 선택)

**다운로드 흐름**

1. 선택된 화질의 HLS 정보 또는 mp4Url과 audioOnly 여부를 `POST /api/download`에 전송
2. 반환된 `downloadId`로 SSE 엔드포인트에 연결
3. `onmessage`에서 진행률 바와 텍스트를 업데이트
4. `done: true`를 받으면 완료 메시지 표시

---

### `public/style.css` — 스타일

다크 테마 기본색조 (`#0f1117` 배경). 섹션별로 구분된 주석으로 구성되어 있습니다.

| 섹션 | 스타일 대상 |
|---|---|
| 쿠키 입력 | `details`, `summary`, input, "저장됨" badge |
| 입력 영역 | URL input, 정보 조회 버튼 |
| 정보 카드 | 썸네일 이미지, 텍스트 영역 |
| 화질 선택 | select, 오디오만 체크박스, 다운로드 버튼 |
| 진행률 | progress bar (그래디엔트) |
| 완료 | 초록색 완료 카드 |

---

## 의존 패키지

| 패키지 | 용도 |
|---|---|
| `express` | HTTP 서버, 정적 파일 제공, API 라우팅 |
| `axios` | 치지직 API 호출, MP4/HLS 세그먼트 다운로드 |
| `ffmpeg-static` | HLS→MP4 변환, m3u8 직접 처리, 오디오 추출 (빌드된 바이너리 포함) |
| `uuid` | 다운로드 작업별 고유 ID 생성 |

---

## 성인 콘텐츠 접근

치지직 성인 콘텐츠는 로그인 상태에서만 API가 `inKey`를 반환합니다.

1. 치지직에 로그인
2. 개발자도구 → Application → Cookies → `chzzk.naver.com`
3. `NID_AUT`과 `NID_SES` 값을 복사
4. 앱의 쿠키 입력 섹션에 붙여넣기 (자동으로 localStorage에 저장됨)
