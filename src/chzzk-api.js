const axios = require("axios");

const CHZZK_API = "https://api.chzzk.naver.com";
const NAVER_API = "https://apis.naver.com";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://chzzk.naver.com",
};

/**
 * Chzzk URL에서 video_no 추출
 * @param {string} url - chzzk.naver.com/video/{video_no}
 * @returns {string|null}
 */
function extractVideoNo(url) {
  const match = url.match(/chzzk\.naver\.com\/video\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * VOD 메타데이터 조회
 * @param {string} videoNo
 * @param {object} [cookies] - 로그인 쿠키 (성인 콘텐츠용)
 * @returns {object}
 */
async function getVideoInfo(videoNo, cookies = {}) {
  const headers = { ...DEFAULT_HEADERS };
  if (Object.keys(cookies).length > 0) {
    headers.Cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  const res = await axios.get(
    `${CHZZK_API}/service/v2/videos/${videoNo}`,
    { headers }
  );

  const data = res.data.content;

  // 라이브 다시보기(Live Rewind) 처리
  let liveRewindPlayback = null;
  if (data.liveRewindPlaybackJson) {
    try {
      liveRewindPlayback = JSON.parse(data.liveRewindPlaybackJson);
    } catch (e) {
      console.warn("Failed to parse liveRewindPlaybackJson:", e.message);
    }
  }

  return {
    title: data.videoTitle,
    channelName: data.channel?.channelName || "",
    thumbnailUrl: data.thumbnailImageUrl || "",
    duration: data.duration, // 초 단위
    videoId: data.videoId,
    inKey: data.inKey,
    adult: data.adult,
    liveRewindPlayback, // 라이브 다시보기 정보
  };
}

/**
 * Playback API 호출 후 해상도별 MP4 직접 다운로드 URL 목록 반환
 *
 * 응답 구조:
 *   period[].adaptationSet[].representation[]
 *     - mimeType: "video/mp4"  → 직접 다운로드 가능한 MP4
 *     - mimeType: "video/mp2t" → HLS 세그먼트 폴더 (사용하지 않음)
 *     - baseURL[0].value       → 실제 URL
 *
 * @param {string} videoId
 * @param {string|null} inKey
 * @param {object|null} liveRewindPlayback - 라이브 다시보기 재생 정보
 * @returns {Array<{ resolution: string, bandwidth: number, url: string }>}
 */
async function getQualities(videoId, inKey, liveRewindPlayback = null) {
  const qualities = [];

  // 라이브 다시보기 처리
  if (liveRewindPlayback && liveRewindPlayback.media) {
    for (const media of liveRewindPlayback.media) {
      if (media.protocol === "HLS" && media.encodingTrack) {
        for (const track of media.encodingTrack) {
          const resolution = track.videoWidth && track.videoHeight
            ? `${track.videoWidth}x${track.videoHeight}`
            : track.encodingTrackId;

          qualities.push({
            resolution,
            bandwidth: track.videoBitRate || 0,
            hls: {
              baseURL: media.path, // m3u8 URL
              representationId: track.encodingTrackId,
              isLiveRewind: true, // 라이브 다시보기 표시
            },
          });
        }
      }
    }

    // bandwidth 내림차순 정렬
    qualities.sort((a, b) => b.bandwidth - a.bandwidth);
    return qualities;
  }

  // 일반 VOD 처리 (기존 로직)
  if (!inKey) {
    return qualities; // inKey가 없으면 빈 배열 반환
  }

  const res = await axios.get(
    `${NAVER_API}/neonplayer/vodplay/v2/playback/${videoId}?key=${inKey}`,
    { headers: DEFAULT_HEADERS }
  );

  const periods = res.data.period || [];

  for (const period of periods) {
    for (const adaptSet of period.adaptationSet || []) {
      if (adaptSet.mimeType === "video/mp4") {
        // 직접 다운로드 가능한 MP4 URL
        for (const rep of adaptSet.representation || []) {
          const url = rep.baseURL?.[0]?.value;
          if (!url) continue;
          qualities.push({
            resolution: rep.height ? `${rep.width}x${rep.height}` : "unknown",
            bandwidth: rep.bandwidth || 0,
            url,
          });
        }
      } else if (adaptSet.mimeType === "video/mp2t") {
        // HLS 세그먼트 정보 추출
        for (const rep of adaptSet.representation || []) {
          const baseURL = rep.baseURL?.[0]?.value;
          const tmpl = rep.segmentTemplate;
          if (!baseURL || !tmpl?.media) continue;

          // segmentTimeline에서 총 세그먼트 수 계산
          let totalSegments = 0;
          for (const s of tmpl.segmentTimeline?.s || []) {
            totalSegments += 1 + (s.r || 0);
          }

          qualities.push({
            resolution: rep.height ? `${rep.width}x${rep.height}` : "unknown",
            bandwidth: rep.bandwidth || 0,
            hls: {
              baseURL,
              representationId: rep.id,
              mediaTemplate: tmpl.media,
              startNumber: tmpl.startNumber || 0,
              totalSegments,
            },
          });
        }
      }
    }
  }

  // bandwidth 내림차순 정렬
  qualities.sort((a, b) => b.bandwidth - a.bandwidth);
  return qualities;
}

module.exports = {
  extractVideoNo,
  getVideoInfo,
  getQualities,
};
