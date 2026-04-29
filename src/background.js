const createSystemNotification = (message, sendResponse) => {
  const id = `gc-${message.type.toLowerCase()}-${Date.now()}`;
  const options = {
    type: "basic",
    title: message.title || "Gallog Cleaner",
    message: message.message || "확인이 필요해 작업을 일시중지했습니다.",
    contextMessage: "디시 갤로그 정리 작업",
    iconUrl: chrome.runtime.getURL("icons/icon_real.png"),
    priority: 2,
    requireInteraction: true,
    isClickable: true
  };

  chrome.notifications.create(id, options, () => {
    const error = chrome.runtime.lastError?.message || "";
    sendResponse({ ok: !error, error });
  });
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GC_RECAPTCHA_DETECTED" || message?.type === "GC_TEST_NOTIFICATION") {
    createSystemNotification(message, sendResponse);
    return true;
  }

  return false;
});
