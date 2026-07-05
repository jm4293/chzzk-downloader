(function () {
  // ── DOM refs ──
  const urlInput = document.getElementById("urlInput");
  const btnInfo = document.getElementById("btnInfo");
  const errorMsg = document.getElementById("errorMsg");
  const infoCard = document.getElementById("infoCard");
  const thumbnail = document.getElementById("thumbnail");
  const videoTitle = document.getElementById("videoTitle");
  const channelName = document.getElementById("channelName");
  const videoDuration = document.getElementById("videoDuration");
  const qualitySection = document.getElementById("qualitySection");
  const qualitySelect = document.getElementById("qualitySelect");
  const btnDownload = document.getElementById("btnDownload");
  const downloadList = document.getElementById("downloadList");

  const cookieDetails = document.getElementById("cookieDetails");
  const cookieNidAut = document.getElementById("cookieNidAut");
  const cookieNidSes = document.getElementById("cookieNidSes");
  const cookieSavedBadge = document.getElementById("cookieSavedBadge");
  const checkAudioOnly = document.getElementById("checkAudioOnly");
  const btnOpenFolder = document.getElementById("btnOpenFolder");

  // ── localStorage 키 ──
  const LS_KEY = "chzzk_cookies";

  function saveCookies() {
    const aut = cookieNidAut.value.trim();
    const ses = cookieNidSes.value.trim();
    if (aut || ses) {
      localStorage.setItem(LS_KEY, JSON.stringify({ NID_AUT: aut, NID_SES: ses }));
      cookieSavedBadge.classList.remove("hidden");
    } else {
      localStorage.removeItem(LS_KEY);
      cookieSavedBadge.classList.add("hidden");
    }
  }

  function loadCookies() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const { NID_AUT, NID_SES } = JSON.parse(raw);
      if (NID_AUT) cookieNidAut.value = NID_AUT;
      if (NID_SES) cookieNidSes.value = NID_SES;
      cookieSavedBadge.classList.remove("hidden");
    } catch (_) {
      // 저장된 값이 없거나 파싱 실패시 무시
    }
  }

  // 페이지 로드 시 복원
  loadCookies();

  // 입력 변경 시 즉시 저장
  cookieNidAut.addEventListener("input", saveCookies);
  cookieNidSes.addEventListener("input", saveCookies);

  // ── 현재 영상 정보 캐시 ──
  let currentTitle = "";
  let currentQualities = [];

  // ── 유틸 ──
  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove("hidden");
  }
  function hideError() {
    errorMsg.classList.add("hidden");
  }
  function hideAll() {
    hideError();
    infoCard.classList.add("hidden");
    qualitySection.classList.add("hidden");
  }

  /** 초 → M:SS 형식 */
  function formatDuration(sec) {
    if (!sec) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // ── 정보 조회 ──
  btnInfo.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    hideAll();
    btnInfo.disabled = true;
    btnInfo.textContent = "조회 중...";

    try {
      // 쿠키 값 수집
      const cookies = {};
      if (cookieNidAut.value.trim()) cookies.NID_AUT = cookieNidAut.value.trim();
      if (cookieNidSes.value.trim()) cookies.NID_SES = cookieNidSes.value.trim();

      const res = await fetch("/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, cookies }),
      });
      const data = await res.json();

      // 성인 콘텐츠 → 쿠키 섹션 자동 열기
      if (res.status === 403 && data.adult) {
        cookieDetails.open = true;
        throw new Error(data.error);
      }

      if (!res.ok) throw new Error(data.error || "알 수 없는 에러");

      // 카드 표시
      currentTitle = data.title;
      thumbnail.src = data.thumbnailUrl;
      videoTitle.textContent = data.title;
      channelName.textContent = data.channelName;
      videoDuration.textContent = data.duration
        ? `재생 시간: ${formatDuration(data.duration)}`
        : "";
      infoCard.classList.remove("hidden");

      // 화질 옵션 표시 (HLS 우선, 동일 해상도 중복 제거)
      qualitySelect.innerHTML = "";
      currentQualities = [];
      if (data.qualities && data.qualities.length > 0) {
        const seen = new Set();
        for (const q of data.qualities) {
          if (seen.has(q.resolution)) continue;
          // HLS가 있으면 우선 사용, 없으면 직접 MP4
          if (q.hls) {
            seen.add(q.resolution);
            currentQualities.push(q);
          }
        }
        // HLS가 없는 해상도는 직접 MP4로 추가
        for (const q of data.qualities) {
          if (!seen.has(q.resolution) && q.url) {
            seen.add(q.resolution);
            currentQualities.push(q);
          }
        }

        currentQualities.forEach((q, i) => {
          const opt = document.createElement("option");
          opt.value = i;
          opt.textContent = `${q.resolution} (${(q.bandwidth / 1000000).toFixed(1)} Mbps)`;
          if (i === 0) opt.selected = true;
          qualitySelect.appendChild(opt);
        });
        qualitySection.classList.remove("hidden");
      } else {
        showError("사용 가능한 화질이 없습니다.");
      }
    } catch (err) {
      showError(err.message);
    } finally {
      btnInfo.disabled = false;
      btnInfo.textContent = "정보 조회";
    }
  });

  // ── 다운로드 목록 항목 ──
  function addDownloadItem(label) {
    const item = document.createElement("div");
    item.className = "dl-item";
    item.innerHTML = `
      <div class="dl-item-header">
        <span class="dl-item-title"></span>
        <span class="dl-item-status">대기 중...</span>
      </div>
      <div class="dl-item-bar"><div class="dl-item-fill"></div></div>`;
    item.querySelector(".dl-item-title").textContent = label;
    downloadList.prepend(item);

    const statusEl = item.querySelector(".dl-item-status");
    const fillEl = item.querySelector(".dl-item-fill");
    return {
      update(msg) {
        if (typeof msg.percent === "number") fillEl.style.width = msg.percent + "%";
        if (msg.status) statusEl.textContent = msg.status;
        else if (typeof msg.percent === "number")
          statusEl.textContent = `다운로드 중 ${msg.percent}%`;
      },
      done(filename) {
        fillEl.style.width = "100%";
        item.classList.add("dl-done");
        statusEl.textContent = filename ? `완료 · ${filename}` : "완료";
      },
      fail(message) {
        item.classList.add("dl-fail");
        statusEl.textContent = `실패 · ${message}`;
      },
    };
  }

  // ── 다운로드 시작 (항목별 SSE 구독, 여러 개 동시 가능) ──
  btnDownload.addEventListener("click", async () => {
    const selected = currentQualities[qualitySelect.value];
    if (!selected) return;

    const audioOnly = checkAudioOnly.checked;
    const label = `${currentTitle} · ${selected.resolution}${audioOnly ? " · 오디오만" : ""}`;

    btnDownload.disabled = true;
    try {
      const body = { title: currentTitle, audioOnly };
      if (selected.hls) {
        body.hls = selected.hls;
      } else {
        body.mp4Url = selected.url;
      }

      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.downloadId) {
        throw new Error(data.error || "다운로드 시작 실패");
      }

      const ui = addDownloadItem(label);
      let finished = false;

      const es = new EventSource(`/api/download/progress/${data.downloadId}`);
      es.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.error) {
          finished = true;
          es.close();
          ui.fail(msg.error);
          return;
        }
        ui.update(msg);
        if (msg.done) {
          finished = true;
          es.close();
          ui.done(msg.filename);
        }
      };
      es.onerror = () => {
        if (!finished) {
          finished = true;
          es.close();
          ui.fail("연결이 중단되었습니다. 다운로드 폴더를 확인하세요.");
        }
      };

      // 다음 다운로드를 바로 받을 수 있게 입력 초기화
      urlInput.value = "";
      hideAll();
      urlInput.focus();
    } catch (err) {
      showError(err.message);
    } finally {
      btnDownload.disabled = false;
    }
  });

  // ── 다운로드 폴더 열기 ──
  btnOpenFolder.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/open-folder", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        showError(data.error || "폴더를 열 수 없습니다.");
      }
    } catch (err) {
      showError(err.message);
    }
  });

  // Enter 키로 정보 조회 트리거
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btnInfo.click();
  });
})();
