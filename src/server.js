const express = require("express");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { extractVideoNo, getVideoInfo, getQualities } = require("./chzzk-api");
const {
  downloadMp4,
  downloadHls,
  extractAudio,
  DOWNLOAD_DIR,
} = require("./downloader");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.resolve(__dirname, "..", "public")));

// 다운로드 상태 맵: downloadId → { lastEvent, client, finished }
// 이벤트를 항상 저장해두므로, SSE 연결이 다운로드 시작·종료보다 늦어도 최신 상태를 받는다
const downloads = new Map();

// 완료 후 클라이언트가 끝내 접속하지 않은 항목의 보관 시간
const FINISHED_TTL_MS = 10 * 60 * 1000;

function sendSSE(downloadId, data) {
  const d = downloads.get(downloadId);
  if (!d) return;
  d.lastEvent = data;
  if (d.client) d.client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function finishSSE(downloadId) {
  const d = downloads.get(downloadId);
  if (!d) return;
  d.finished = true;
  if (d.client) {
    d.client.end();
    downloads.delete(downloadId);
  } else {
    setTimeout(() => downloads.delete(downloadId), FINISHED_TTL_MS);
  }
}

function hasActiveDownloads() {
  for (const d of downloads.values()) {
    if (!d.finished) return true;
  }
  return false;
}

// ─── 다운로드 대기열 ──────────────────────────────────────────
// HLS 다운로드 하나가 세그먼트 8개를 병렬로 받으므로,
// 동시 실행을 제한하고 나머지는 순서대로 대기시킨다
const MAX_CONCURRENT_DOWNLOADS = 2;
let runningDownloads = 0;
const downloadQueue = [];

function enqueueDownload(run) {
  downloadQueue.push(run);
  pumpQueue();
}

function pumpQueue() {
  while (runningDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
    const run = downloadQueue.shift();
    runningDownloads++;
    run().finally(() => {
      runningDownloads--;
      pumpQueue();
    });
  }
}

// ─── POST /api/info ──────────────────────────────────────────
// body: { url }
// 반환: { title, channelName, thumbnailUrl, duration, qualities }
app.post("/api/info", async (req, res) => {
  try {
    const { url, cookies } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: "URL을 입력해주세요." });
    }

    const videoNo = extractVideoNo(url);
    if (!videoNo) {
      return res.status(400).json({
        error:
          "올바르지 않은 치지직 VOD URL입니다.\n예: https://chzzk.naver.com/video/1978",
      });
    }

    const info = await getVideoInfo(videoNo, cookies || {});

    if (!info.videoId) {
      return res
        .status(500)
        .json({ error: "영상 정보를 가져올 수 없습니다. (videoId 없음)" });
    }

    // inKey가 없지만 라이브 다시보기 정보가 있는 경우
    if (!info.inKey && !info.liveRewindPlayback) {
      // 성인 콘텐츠이면서 쿠키 미제공인 경우
      if (info.adult) {
        return res.status(403).json({
          error: "성인 콘텐츠입니다. NID_AUT / NID_SES 쿠키를 입력해주세요.",
          adult: true,
          title: info.title,
          channelName: info.channelName,
          thumbnailUrl: info.thumbnailUrl,
          duration: info.duration,
        });
      }
      return res
        .status(500)
        .json({ error: "영상 정보를 가져올 수 없습니다. (재생 정보 없음)" });
    }

    const qualities = await getQualities(info.videoId, info.inKey, info.liveRewindPlayback);

    res.json({
      title: info.title,
      channelName: info.channelName,
      thumbnailUrl: info.thumbnailUrl,
      duration: info.duration,
      adult: info.adult,
      qualities,
    });
  } catch (err) {
    console.error("[/api/info]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/download ──────────────────────────────────────
// body: { title, mp4Url }
// 반환: { downloadId }  (SSE로 진행률 전달)
app.post("/api/download", (req, res) => {
  const { title, mp4Url, hls, audioOnly } = req.body || {};
  if (!title || (!mp4Url && !hls)) {
    return res
      .status(400)
      .json({ error: "title과 mp4Url 또는 hls 정보가 필요합니다." });
  }

  const downloadId = uuidv4();
  downloads.set(downloadId, { lastEvent: null, client: null, finished: false });
  res.json({ downloadId });

  sendSSE(downloadId, { percent: 0, status: "대기 중..." });

  // 대기열을 통해 백그라운드 다운로드 (이벤트가 상태 맵에 저장되므로 SSE 연결을 기다릴 필요 없음)
  enqueueDownload(async () => {
    try {
      // 1단계: 다운로드 (HLS 또는 직접 MP4)
      const progressScale = audioOnly ? 0.5 : 1;
      const onDownloadProgress = (percent) => {
        sendSSE(downloadId, { percent: Math.round(percent * progressScale) });
      };

      // 대기열에서 빠져나와 실제 시작될 때 상태 갱신
      sendSSE(downloadId, {
        percent: 0,
        status: hls ? "세그먼트 다운로드 중..." : "다운로드 중...",
      });

      const mp4Path = hls
        ? await downloadHls(hls, title, onDownloadProgress)
        : await downloadMp4(mp4Url, title, onDownloadProgress);

      let finalPath = mp4Path;

      // 2단계: 오디오만 추출 (audioOnly일 때만)
      if (audioOnly) {
        sendSSE(downloadId, { percent: 50, status: "오디오 추출 중..." });
        finalPath = await extractAudio(mp4Path);
      }

      sendSSE(downloadId, {
        percent: 100,
        done: true,
        filename: path.basename(finalPath),
        dir: DOWNLOAD_DIR,
      });
      finishSSE(downloadId);
      console.log("[download] 완료:", finalPath);
    } catch (err) {
      sendSSE(downloadId, { error: err.message });
      finishSSE(downloadId);
      console.error("[download] 에러:", err.message);
    }
  });
});

// ─── GET /api/download/progress/:downloadId (SSE) ───────────
app.get("/api/download/progress/:downloadId", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const downloadId = req.params.downloadId;
  const d = downloads.get(downloadId);
  if (!d) {
    res.write(`data: ${JSON.stringify({ error: "알 수 없는 다운로드입니다." })}\n\n`);
    return res.end();
  }

  // 연결 전에 쌓인 최신 상태를 즉시 전달 (빠른 실패/완료 유실 방지)
  if (d.lastEvent) {
    res.write(`data: ${JSON.stringify(d.lastEvent)}\n\n`);
  }
  if (d.finished) {
    downloads.delete(downloadId);
    return res.end();
  }

  d.client = res;
  req.on("close", () => {
    if (d.client === res) d.client = null;
  });
});

// ─── POST /api/open-folder ───────────────────────────────────
// 다운로드 폴더를 OS 파일 탐색기(Finder)로 연다
app.post("/api/open-folder", (req, res) => {
  const { execFile } = require("child_process");
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  execFile(opener, [DOWNLOAD_DIR], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ─── GET /api/download/file/:filename ────────────────────────
app.get("/api/download/file/:filename", (req, res) => {
  // basename으로 경로 탐색(../) 차단
  const filePath = path.join(DOWNLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
  }
  res.download(filePath);
});

// ─── 루트 ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.resolve(__dirname, "..", "public", "index.html"));
});

function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`✅ Chzzk VOD Downloader 서버 실행: http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

// node src/server.js 로 직접 실행할 때만 자동으로 리슨 (Electron에서는 start()를 호출)
if (require.main === module) {
  start();
}

module.exports = { app, start, PORT, hasActiveDownloads };
