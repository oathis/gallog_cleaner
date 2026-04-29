(() => {
  if (window.__gcInjected) return;
  window.__gcInjected = true;

  const originalConfirm = window.confirm.bind(window);
  const originalAlert = window.alert.bind(window);
  const autoAlertPatterns = [
    /글\s*번호가\s*올바르지\s*않습니다/
  ];
  let automationMode = false;

  window.addEventListener("GC_CONFIRM_MODE", (event) => {
    automationMode = Boolean(event.detail?.enabled);
  });

  window.confirm = (message) => {
    if (automationMode) {
      return true;
    }

    return originalConfirm(message);
  };

  window.alert = (message) => {
    const text = String(message ?? "");
    const shouldAutoAccept = automationMode && autoAlertPatterns.some((pattern) => pattern.test(text));

    if (shouldAutoAccept) {
      window.dispatchEvent(new CustomEvent("GC_PAGE_ALERT", {
        detail: {
          message: text,
          handled: true
        }
      }));
      return;
    }

    return originalAlert(message);
  };
})();
