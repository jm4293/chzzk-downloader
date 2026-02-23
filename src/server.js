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

// SSE 연결 맵: downloadId → res
const sseClients = new Map();

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
  res.json({ downloadId });

  function sendSSE(data) {
    const client = sseClients.get(downloadId);
    if (client) client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  function closeSSE() {
    const client = sseClients.get(downloadId);
    if (client) {
      client.end();
      sseClients.delete(downloadId);
    }
  }

  // 백그라운드 다운로드 (SSE 연결 준비 시간 확보용 0.5s 대기)
  setTimeout(async () => {
    try {
      // 1단계: 다운로드 (HLS 또는 직접 MP4)
      const progressScale = audioOnly ? 0.5 : 1;
      const onDownloadProgress = (percent) => {
        sendSSE({ percent: Math.round(percent * progressScale) });
      };

      if (hls) sendSSE({ percent: 0, status: "세그먼트 다운로드 중..." });

      const mp4Path = hls
        ? await downloadHls(hls, title, onDownloadProgress)
        : await downloadMp4(mp4Url, title, onDownloadProgress);

      let finalPath = mp4Path;

      // 2단계: 오디오만 추출 (audioOnly일 때만)
      if (audioOnly) {
        sendSSE({ percent: 50, status: "오디오 추출 중..." });
        finalPath = await extractAudio(mp4Path);
      }

      sendSSE({ percent: 100, done: true, filename: path.basename(finalPath) });
      closeSSE();
      console.log("[download] 완료:", finalPath);
    } catch (err) {
      sendSSE({ error: err.message });
      closeSSE();
      console.error("[download] 에러:", err.message);
    }
  }, 500);
});

// ─── GET /api/download/progress/:downloadId (SSE) ───────────
app.get("/api/download/progress/:downloadId", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.set(req.params.downloadId, res);

  req.on("close", () => {
    sseClients.delete(req.params.downloadId);
  });
});

// ─── GET /api/download/file/:filename ────────────────────────
app.get("/api/download/file/:filename", (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
  }
  res.download(filePath);
});

// ─── 루트 ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.resolve(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Chzzk VOD Downloader 서버 실행: http://localhost:${PORT}`);
});

module.exports = app;
