const axios = require("axios");
const path = require("path");
const fs = require("fs");

// Electron 앱에서는 CHZZK_DOWNLOAD_DIR로 저장 위치를 지정 (앱 패키지 내부는 읽기 전용)
const DOWNLOAD_DIR =
  process.env.CHZZK_DOWNLOAD_DIR || path.resolve(__dirname, "..", "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// asar 패키지 내부의 ffmpeg 바이너리는 실행 불가 → unpacked 경로로 치환
function getFfmpegPath() {
  return require("ffmpeg-static").replace("app.asar", "app.asar.unpacked");
}

// 진행 중인 다운로드가 사용 중인 출력 경로 (같은 제목 동시 다운로드 충돌 방지)
const activePaths = new Set();

/**
 * 기존 파일·진행 중 다운로드와 겹치지 않는 출력 경로를 확보
 * 겹치면 " (1)", " (2)"... 를 붙인다. 사용이 끝나면 releasePath()로 해제할 것.
 */
function reserveOutputPath(baseName, ext) {
  const safe = sanitizeFilename(baseName) || "download";
  let candidate = path.join(DOWNLOAD_DIR, `${safe}${ext}`);
  for (let n = 1; fs.existsSync(candidate) || activePaths.has(candidate); n++) {
    candidate = path.join(DOWNLOAD_DIR, `${safe} (${n})${ext}`);
  }
  activePaths.add(candidate);
  return candidate;
}

function releasePath(p) {
  activePaths.delete(p);
}

/** 세그먼트 하나를 재시도·타임아웃과 함께 다운로드 */
async function fetchSegment(url, headers, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        headers,
        timeout: 30 * 1000,
      });
      return Buffer.from(res.data);
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, " ").trim();
}

/**
 * MP4 URL을 스트리밍 다운로드하여 파일로 저장
 * @param {string} mp4Url
 * @param {string} title
 * @param {function} onProgress - (percent) => void
 * @returns {Promise<string>} 저장된 파일 경로
 */
async function downloadMp4(mp4Url, title, onProgress = () => {}) {
  const outputPath = reserveOutputPath(title, ".mp4");

  let res;
  try {
    res = await axios.get(mp4Url, {
      responseType: "stream",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: "https://chzzk.naver.com",
      },
      maxRedirects: 10,
    });
  } catch (err) {
    releasePath(outputPath);
    throw err;
  }

  const totalSize = parseInt(res.headers["content-length"], 10) || 0;
  let downloadedSize = 0;
  let lastPercent = 0;

  // 30초 내에 새 데이터가 안 오면 다운로드 실패로 처리 (CDN 스로틀링 대응)
  const IDLE_TIMEOUT_MS = 30 * 1000;

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    let settled = false;
    let idleTimer = null;

    const { PassThrough } = require("stream");
    const tracker = new PassThrough();

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        res.data.destroy();
        done(
          new Error(
            "다운로드가 30초 동안 진행되지 않아 중단했습니다. 다시 시도해주세요."
          )
        );
      }, IDLE_TIMEOUT_MS);
    }

    function done(err) {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      releasePath(outputPath);
      if (err) {
        writer.destroy();
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        reject(err);
      } else {
        resolve(outputPath);
      }
    }

    resetIdleTimer();

    tracker.on("data", (chunk) => {
      downloadedSize += chunk.length;
      resetIdleTimer();
      if (totalSize > 0) {
        const percent = Math.min(
          Math.round((downloadedSize / totalSize) * 100),
          100
        );
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    });

    res.data.pipe(tracker).pipe(writer);

    writer.on("finish", () => {
      if (lastPercent < 100) onProgress(100);
      done(null);
    });
    writer.on("error", (err) => done(err));
    res.data.on("error", (err) => done(err));
  });
}

/**
 * HLS 세그먼트를 순차 다운로드하여 MP4로 저장
 * @param {object} hls - { baseURL, representationId, mediaTemplate, startNumber, totalSegments, isLiveRewind }
 * @param {string} title
 * @param {function} onProgress - (percent) => void
 * @returns {Promise<string>} 저장된 MP4 경로
 */
async function downloadHls(hls, title, onProgress = () => {}) {
  const ffmpegPath = getFfmpegPath();
  const { execFile } = require("child_process");

  const outputPath = reserveOutputPath(title, ".mp4");

  // 라이브 다시보기 m3u8 URL인 경우 ffmpeg로 직접 다운로드
  if (hls.isLiveRewind && hls.baseURL) {
    return new Promise((resolve, reject) => {
      const process = execFile(
        ffmpegPath,
        [
          "-i", hls.baseURL,
          "-c", "copy",
          "-bsf:a", "aac_adtstoasc",
          "-y",
          outputPath,
        ],
        { maxBuffer: 1024 * 1024 * 50 },
        (err) => {
          releasePath(outputPath);
          if (err) {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            reject(err);
          } else {
            resolve(outputPath);
          }
        }
      );

      // ffmpeg 진행률 파싱 (stderr에서 time= 추출)
      let duration = null;
      process.stderr?.on("data", (data) => {
        const str = data.toString();

        // Duration 파싱
        if (!duration) {
          const durationMatch = str.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
          if (durationMatch) {
            const [, h, m, s] = durationMatch;
            duration = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
          }
        }

        // 진행 시간 파싱
        if (duration) {
          const timeMatch = str.match(/time=(\d+):(\d+):(\d+\.\d+)/);
          if (timeMatch) {
            const [, h, m, s] = timeMatch;
            const currentTime = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
            const percent = Math.min(Math.round((currentTime / duration) * 100), 99);
            onProgress(percent);
          }
        }
      });
    });
  }

  // 기존 세그먼트 다운로드 방식 (일반 VOD HLS)
  const tsPath = reserveOutputPath(title, ".ts");
  const { totalSegments, startNumber, baseURL, representationId, mediaTemplate } = hls;

  const CONCURRENCY = 8;
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Referer: "https://chzzk.naver.com",
  };

  function segUrl(i) {
    const num = String(startNumber + i).padStart(6, "0");
    return baseURL + mediaTemplate
      .replace("$RepresentationID$", representationId)
      .replace("$Number%06d$", num);
  }

  // 배치 단위로 병렬 다운로드, 완료 후 순서대로 파일에 기록
  const writer = fs.createWriteStream(tsPath);
  let completed = 0;
  let lastPercent = 0;

  try {
    for (let batch = 0; batch < totalSegments; batch += CONCURRENCY) {
      const end = Math.min(batch + CONCURRENCY, totalSegments);
      const chunks = await Promise.all(
        Array.from({ length: end - batch }, (_, j) =>
          fetchSegment(segUrl(batch + j), headers)
        )
      );

      for (const chunk of chunks) {
        writer.write(chunk);
        completed++;
        const percent = Math.round((completed / totalSegments) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    }

    await new Promise((resolve, reject) => {
      writer.end(() => resolve());
      writer.on("error", reject);
    });

    // TS → MP4 변환 (ffmpeg)
    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        [
          "-i", tsPath,
          "-c", "copy",
          "-y",
          outputPath,
        ],
        { maxBuffer: 1024 * 1024 * 10 },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    return outputPath;
  } catch (err) {
    // 실패 시 쓰다 만 출력 파일 정리
    writer.destroy();
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw err;
  } finally {
    if (fs.existsSync(tsPath)) fs.unlinkSync(tsPath);
    releasePath(tsPath);
    releasePath(outputPath);
  }
}

/**
 * MP4 파일에서 오디오만 추출 → M4A로 저장 (ffmpeg)
 * @param {string} mp4Path - 소스 MP4 경로
 * @returns {Promise<string>} 저장된 M4A 경로
 */
function extractAudio(mp4Path) {
  const ffmpegPath = getFfmpegPath();
  const { execFile } = require("child_process");

  const m4aPath = reserveOutputPath(path.basename(mp4Path, ".mp4"), ".m4a");

  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        "-i", mp4Path,
        "-vn",           // 비디오 제거
        "-c:a", "copy",  // 오디오 재인코딩 없이 복사
        "-y",
        m4aPath,
      ],
      { maxBuffer: 1024 * 1024 * 10 },
      (err) => {
        releasePath(m4aPath);
        if (err) {
          if (fs.existsSync(m4aPath)) fs.unlinkSync(m4aPath);
          reject(err);
        } else {
          // 소스 MP4는 삭제
          if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path);
          resolve(m4aPath);
        }
      }
    );
  });
}

module.exports = {
  downloadMp4,
  downloadHls,
  extractAudio,
  DOWNLOAD_DIR,
};
