(async () => {
  const status = document.querySelector("#status");
  const openPanel = document.querySelector("#openPanel");
  const testNotification = document.querySelector("#testNotification");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isGallog = /^https?:\/\/gallog\.dcinside\.com\//.test(tab?.url || "");

  if (!isGallog) {
    status.textContent = "갤로그 페이지에서만 동작합니다.";
    openPanel.disabled = true;
  }

  if (isGallog) {
    status.textContent = "갤로그 페이지가 감지됐습니다.";
  }

  openPanel.addEventListener("click", async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "GC_OPEN_PANEL" });
      window.close();
    } catch (error) {
      status.textContent = "페이지를 새로고침한 뒤 다시 눌러주세요.";
    }
  });

  testNotification.addEventListener("click", async () => {
    const result = await chrome.runtime.sendMessage({
      type: "GC_TEST_NOTIFICATION",
      title: "Gallog Cleaner 알림 테스트",
      message: "이 알림이 보이면 리캡챠 일시중지 알림도 컴퓨터에 표시됩니다."
    }).catch((error) => ({ ok: false, error: error.message }));

    status.textContent = result?.ok
      ? "테스트 알림을 보냈습니다."
      : `알림 실패: ${result?.error || "알 수 없는 오류"}`;
  });
})();
