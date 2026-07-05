const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");

// 다운로드 저장 위치: ~/Downloads/chzzk (server/downloader가 require되기 전에 설정)
process.env.CHZZK_DOWNLOAD_DIR =
  process.env.CHZZK_DOWNLOAD_DIR || path.join(app.getPath("downloads"), "chzzk");

const { start, PORT, hasActiveDownloads } = require("../src/server");

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 780,
    title: "Chzzk VOD Downloader",
  });

  // 다운로드 진행 중에 창을 닫으면 확인창을 띄운다
  win.on("close", (e) => {
    if (!hasActiveDownloads()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["취소", "종료"],
      defaultId: 0,
      cancelId: 0,
      message: "다운로드가 진행 중입니다.",
      detail: "지금 종료하면 진행 중인 다운로드가 중단됩니다.",
    });
    if (choice === 0) e.preventDefault();
  });

  win.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(async () => {
  try {
    await start();
  } catch (err) {
    // 이미 npm start 등으로 서버가 떠 있으면 그대로 재사용
    if (err.code !== "EADDRINUSE") {
      console.error("서버 시작 실패:", err);
      app.quit();
      return;
    }
  }
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
