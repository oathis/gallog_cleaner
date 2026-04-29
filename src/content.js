(() => {
  const JOB_KEY = "gcActiveJob";
  const JOB_TTL_MS = 30 * 60 * 1000;
  const MAX_LIMIT = 100000;

  const DEFAULTS = {
    delayMs: 1000,
    limit: 100,
    autoNextPage: false,
    galleryMode: "include",
    selectedGalleryIds: []
  };

  const state = {
    running: false,
    stopped: false,
    deleted: 0,
    failures: 0,
    panel: null,
    controls: {},
    injected: null,
    recaptchaNotified: false,
    recaptchaObserver: null,
    stopReason: "",
    paused: false,
    currentJob: null,
    galleries: [],
    selectedGalleryIds: new Set(),
    hasStoredJob: false,
    autoAlertCount: 0,
    lastAutoAlert: ""
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const normalizeOptions = (options) => {
    const selectedGalleryIds = Array.isArray(options?.selectedGalleryIds)
      ? options.selectedGalleryIds.map((id) => String(id)).filter(Boolean)
      : [];

    return {
      delayMs: Math.min(10000, Math.max(500, Number(options?.delayMs) || DEFAULTS.delayMs)),
      limit: Math.min(MAX_LIMIT, Math.max(1, Number(options?.limit) || DEFAULTS.limit)),
      autoNextPage: Boolean(options?.autoNextPage),
      galleryMode: options?.galleryMode === "exclude" ? "exclude" : "include",
      selectedGalleryIds: [...new Set(selectedGalleryIds)]
    };
  };

  const getCurrentCno = () => new URL(location.href).searchParams.get("cno") || "";

  const getScopeKey = () => `${location.pathname}?cno=${getCurrentCno()}`;

  const getCurrentSection = () => {
    if (location.pathname.includes("/posting/")) return "posting";
    if (location.pathname.includes("/comment/")) return "comment";
    return "other";
  };

  const jobMatchesCurrentScope = (job) => {
    if (job?.scopeKey) {
      return job.scopeKey === getScopeKey();
    }

    return job?.scopePath === location.pathname;
  };

  const readOptions = async () => {
    const saved = await chrome.storage.local.get(DEFAULTS);
    return normalizeOptions(saved);
  };

  const saveOptions = async (options) => {
    await chrome.storage.local.set(normalizeOptions(options));
  };

  const createJob = (options) => ({
    active: true,
    options: normalizeOptions(options),
    scopePath: location.pathname,
    scopeKey: getScopeKey(),
    remaining: normalizeOptions(options).limit,
    attempted: 0,
    failures: 0,
    startedAt: Date.now(),
    updatedAt: Date.now()
  });

  const normalizeJob = (job) => {
    if (!job || !job.active) return null;

    const updatedAt = Number(job.updatedAt) || 0;
    if (Date.now() - updatedAt > JOB_TTL_MS) {
      return null;
    }

    const options = normalizeOptions(job.options);
    return {
      ...job,
      options,
      scopePath: job.scopePath || location.pathname,
      scopeKey: job.scopeKey || job.scopePath || getScopeKey(),
      remaining: Math.max(0, Number(job.remaining) || 0),
      attempted: Math.max(0, Number(job.attempted) || 0),
      failures: Math.max(0, Number(job.failures) || 0),
      paused: Boolean(job.paused),
      pauseReason: job.pauseReason || ""
    };
  };

  const readJob = async () => {
    const data = await chrome.storage.local.get(JOB_KEY);
    const job = normalizeJob(data[JOB_KEY]);

    if (!job) {
      await chrome.storage.local.remove(JOB_KEY);
      state.hasStoredJob = false;
      return null;
    }

    state.hasStoredJob = true;
    return job;
  };

  const writeJob = async (job) => {
    state.hasStoredJob = true;
    await chrome.storage.local.set({
      [JOB_KEY]: {
        ...job,
        updatedAt: Date.now()
      }
    });
  };

  const clearJob = async () => {
    state.hasStoredJob = false;
    await chrome.storage.local.remove(JOB_KEY);
  };

  const readOptionsFromControls = () => normalizeOptions({
    delayMs: state.controls.delay?.value,
    limit: state.controls.limit?.value,
    autoNextPage: state.controls.autoNextPage?.checked,
    galleryMode: state.controls.galleryModeInclude?.checked ? "include" : "exclude",
    selectedGalleryIds: [...state.selectedGalleryIds]
  });

  const getGalleryName = (id) => state.galleries.find((gallery) => gallery.id === id)?.name || `cno ${id}`;

  const collectGalleryOptions = () => {
    const nodes = [
      ...document.querySelectorAll(".option_sort.gallog li[data-value], .select_box.select_arraybox li[data-value]")
    ];
    const byId = new Map();

    for (const node of nodes) {
      const id = String(node.dataset.value || "").trim();
      const name = cleanText(node.textContent);

      if (!id || !name || name === "전체 보기" || byId.has(id)) {
        continue;
      }

      byId.set(id, { id, name });
    }

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  };

  const renderGalleryChips = () => {
    if (!state.controls.selectedGalleries) return;

    const ids = [...state.selectedGalleryIds];
    if (ids.length === 0) {
      state.controls.selectedGalleries.innerHTML = `<span class="gc-empty">선택 없음</span>`;
      return;
    }

    state.controls.selectedGalleries.textContent = "";
    for (const id of ids) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "gc-chip";
      chip.dataset.galleryId = id;
      chip.title = "선택 해제";
      chip.textContent = `${getGalleryName(id)} ×`;
      state.controls.selectedGalleries.append(chip);
    }
  };

  const renderGalleryPicker = () => {
    if (!state.controls.galleryPicker) return;

    state.controls.galleryPicker.textContent = "";

    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "현재 페이지 전체";
    state.controls.galleryPicker.append(allOption);

    for (const gallery of state.galleries) {
      const option = document.createElement("option");
      option.value = gallery.id;
      option.textContent = gallery.name;
      option.disabled = state.selectedGalleryIds.has(gallery.id);
      state.controls.galleryPicker.append(option);
    }

    state.controls.galleryPicker.value = "";
    renderGalleryChips();
  };

  const refreshGalleryOptions = () => {
    state.galleries = collectGalleryOptions();
    renderGalleryPicker();

    const currentCno = getCurrentCno();
    const currentName = currentCno ? getGalleryName(currentCno) : "전체";
    const section = getCurrentSection() === "comment" ? "댓글" : getCurrentSection() === "posting" ? "게시글" : "현재";
    setStatus(`${section} 섹션 갤러리 목록 ${state.galleries.length}개를 읽었습니다.\n현재 필터: ${currentName}`);
  };

  const applyOptionsToControls = (options) => {
    const normalized = normalizeOptions(options);

    if (state.controls.limit) state.controls.limit.value = String(normalized.limit);
    if (state.controls.delay) state.controls.delay.value = String(normalized.delayMs);
    if (state.controls.autoNextPage) state.controls.autoNextPage.checked = normalized.autoNextPage;
    if (state.controls.galleryModeInclude) state.controls.galleryModeInclude.checked = normalized.galleryMode === "include";
    if (state.controls.galleryModeExclude) state.controls.galleryModeExclude.checked = normalized.galleryMode === "exclude";

    state.selectedGalleryIds = new Set(normalized.selectedGalleryIds);
    renderGalleryPicker();
  };

  const detectItemGalleryIds = (item) => {
    const currentCno = getCurrentCno();
    if (currentCno) {
      return [currentCno];
    }

    const anchorTexts = [...item.querySelectorAll("a")].map((anchor) => cleanText(anchor.textContent));
    const exactMatches = state.galleries
      .filter((gallery) => anchorTexts.includes(gallery.name))
      .map((gallery) => gallery.id);

    if (exactMatches.length > 0) {
      return exactMatches;
    }

    const itemText = cleanText(item.textContent);
    return [...state.galleries]
      .sort((a, b) => b.name.length - a.name.length)
      .filter((gallery) => itemText.includes(gallery.name))
      .map((gallery) => gallery.id);
  };

  const buttonPassesGalleryFilter = (button, options) => {
    const selectedIds = new Set(options.selectedGalleryIds);
    if (selectedIds.size === 0) {
      return true;
    }

    const item = button.closest("li, tr, .cont, .reply, .scrap");
    if (!item) {
      return false;
    }

    const itemGalleryIds = detectItemGalleryIds(item);
    if (itemGalleryIds.length === 0) {
      return false;
    }

    const matched = itemGalleryIds.some((id) => selectedIds.has(id));
    return options.galleryMode === "exclude" ? !matched : matched;
  };

  const getButtonGalleryLabel = (button) => {
    const item = button.closest("li, tr, .cont, .reply, .scrap");
    if (!item) return "갤러리 미확인";

    const ids = detectItemGalleryIds(item);
    if (ids.length === 0) return "갤러리 미확인";

    return ids.map(getGalleryName).join(", ");
  };

  const getRecaptchaSignal = () => {
    const selectors = [
      'iframe[src*="google.com/recaptcha"]',
      'iframe[src*="www.recaptcha.net/recaptcha"]',
      'iframe[title*="reCAPTCHA"]',
      ".g-recaptcha",
      '[data-sitekey][class*="g-recaptcha"]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && isVisible(element)) {
        return selector;
      }
    }

    const pageText = document.body?.innerText || "";
    if (/reCAPTCHA|로봇이\s*아닙니다|자동\s*등록\s*방지|보안문자/i.test(pageText)) {
      return "captcha text";
    }

    return "";
  };

  const notifyRecaptcha = async () => {
    if (state.recaptchaNotified) return;
    state.recaptchaNotified = true;

    const message = state.paused
      ? "리캡챠 또는 자동화 확인 화면이 감지되어 삭제 작업을 일시중지했습니다. 페이지에서 직접 확인을 마친 뒤 패널의 계속 버튼을 누르세요."
      : "리캡챠 또는 자동화 확인 화면이 감지되어 작업을 시작하지 않았습니다. 페이지에서 직접 확인을 마친 뒤 다시 시작하세요.";
    setStatus(`일시중지됨.\n${message}`);

    const notificationResult = await chrome.runtime.sendMessage({
      type: "GC_RECAPTCHA_DETECTED",
      title: "Gallog Cleaner 일시중지됨",
      message
    }).catch(() => {});

    if (notificationResult && notificationResult.ok === false) {
      setStatus(`일시중지됨.\n${message}\n\n시스템 알림 실패: ${notificationResult.error}`);
    }

    window.alert(`[Gallog Cleaner]\n${message}`);
  };

  const pauseJobForRecaptcha = async (job) => {
    if (!job || job.remaining <= 0) return;

    job.paused = true;
    job.pauseReason = "recaptcha";
    job.pausedAt = Date.now();
    await writeJob(job);
  };

  const stopForRecaptcha = async (job = state.currentJob) => {
    state.stopped = true;
    state.stopReason = "recaptcha";
    state.paused = Boolean(job && job.remaining > 0);
    await pauseJobForRecaptcha(job);
    await setConfirmBypass(false);
    syncButtons();
    await notifyRecaptcha();
  };

  const stopIfRecaptchaDetected = async (job = state.currentJob) => {
    const signal = getRecaptchaSignal();
    if (!signal) return false;

    await stopForRecaptcha(job);
    return true;
  };

  const startRecaptchaWatcher = () => {
    if (state.recaptchaObserver) return;

    let pending = false;
    state.recaptchaObserver = new MutationObserver(() => {
      if (!state.running || pending) return;

      pending = true;
      window.setTimeout(() => {
        pending = false;

        if (state.running) {
          stopIfRecaptchaDetected(state.currentJob);
        }
      }, 150);
    });

    state.recaptchaObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "src", "title"]
    });
  };

  const findRawDeleteButtons = () => {
    const selectors = [
      "button.btn_delete.btn_listdel",
      "button.btn_delete",
      ".btn_listdel"
    ];

    const buttons = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    return [...new Set(buttons)].filter((button) => {
      const item = button.closest("li, tr, .cont, .reply, .scrap");
      return item && item.dataset.gcClicked !== "true" && isVisible(button);
    });
  };

  const findDeleteButtons = (options = readOptionsFromControls()) => {
    return findRawDeleteButtons().filter((button) => buttonPassesGalleryFilter(button, options));
  };

  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  const getPagingContainers = () => [
    ...document.querySelectorAll(".bottom_paging_box, .iconpaging, .paging, .pagination, [class*='paging']")
  ];

  const isInPagingContainer = (element) => Boolean(element.closest(".bottom_paging_box, .iconpaging, .paging, .pagination, [class*='paging']"));

  const getLikelyPagingLinks = () => {
    const containerLinks = getPagingContainers().flatMap((container) => [...container.querySelectorAll("a")]);
    const allNumericLinks = [...document.querySelectorAll("a")].filter((link) => {
      const text = cleanText(link.textContent);
      if (!/^\d+$/.test(text)) return false;

      const href = link.getAttribute("href") || "";
      const onclick = link.getAttribute("onclick") || "";
      const target = `${href} ${onclick}`;
      return isInPagingContainer(link) || /\/(posting|comment|scrap|guestbook)\/index|[?&](page|p)=/i.test(target);
    });

    return [...new Set([...containerLinks, ...allNumericLinks])]
      .filter((link) => link instanceof HTMLAnchorElement && isVisible(link));
  };

  const getVisibleNumericPageLinks = () => getLikelyPagingLinks()
    .map((link) => ({ link, page: getPageNumberFromLink(link) }))
    .filter((item) => Number.isInteger(item.page) && item.page > 0);

  const getCurrentPageNumber = () => {
    const currentSelectors = [
      ".bottom_paging_box .on",
      ".bottom_paging_box strong",
      ".bottom_paging_box em",
      ".bottom_paging_box span.num",
      ".iconpaging .on",
      ".iconpaging strong",
      ".iconpaging em",
      ".iconpaging span.num",
      "[class*='paging'] .on",
      "[class*='paging'] strong",
      "[class*='paging'] em",
      "[class*='paging'] span.num"
    ];

    for (const selector of currentSelectors) {
      const element = document.querySelector(selector);
      const page = Number(cleanText(element?.textContent));
      if (Number.isInteger(page) && page > 0) {
        return page;
      }
    }

    const params = new URL(location.href).searchParams;
    const urlPages = [...params.getAll("page"), ...params.getAll("p")]
      .map((value) => Number(value))
      .filter((page) => Number.isInteger(page) && page > 0);
    const urlPage = urlPages.at(-1);
    if (urlPage) {
      return urlPage;
    }

    const visiblePages = getVisibleNumericPageLinks().map((item) => item.page).sort((a, b) => a - b);
    if (visiblePages.length > 0 && visiblePages[0] > 1) {
      return visiblePages[0] - 1;
    }

    return 1;
  };

  const getPageNumberFromLink = (link) => {
    const textPage = Number(cleanText(link.textContent));
    if (Number.isInteger(textPage) && textPage > 0) {
      return textPage;
    }

    try {
      const url = new URL(link.href, location.href);
      const pages = [...url.searchParams.getAll("page"), ...url.searchParams.getAll("p")]
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      const page = pages.at(-1) || 0;
      return Number.isInteger(page) && page > 0 ? page : 0;
    } catch (error) {
      return 0;
    }
  };

  const findNextPageLink = () => {
    const currentPage = getCurrentPageNumber();
    const numericLinks = getVisibleNumericPageLinks();

    const nextNumberLink = numericLinks.find((item) => item.page === currentPage + 1)?.link;
    if (nextNumberLink) {
      return nextNumberLink;
    }

    const blockNextSelectors = [
      ".bottom_paging_box a.page_next",
      ".bottom_paging_box a.next",
      ".iconpaging a.page_next",
      ".iconpaging a.next",
      "[class*='paging'] a.page_next",
      "[class*='paging'] a.next",
      "a.page_next",
      "a.next"
    ];

    for (const selector of blockNextSelectors) {
      const link = document.querySelector(selector);
      if (link instanceof HTMLAnchorElement && link.href && isVisible(link)) {
        return link;
      }
    }

    return null;
  };

  const getPaginationDebugText = () => {
    const currentPage = getCurrentPageNumber();
    const pages = [...new Set(getVisibleNumericPageLinks().map((item) => item.page))]
      .sort((a, b) => a - b)
      .slice(0, 12)
      .join(", ");

    return `현재 ${currentPage}페이지, 보이는 숫자 링크: ${pages || "없음"}`;
  };

  const ensureInjected = () => {
    if (state.injected) return state.injected;

    state.injected = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("src/injected.js");
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("Injected script failed to load."));
      };
      (document.head || document.documentElement).append(script);
    });

    return state.injected;
  };

  const setConfirmBypass = async (enabled) => {
    await ensureInjected();
    window.dispatchEvent(new CustomEvent("GC_CONFIRM_MODE", { detail: { enabled } }));
  };

  const handlePageAlert = async (event) => {
    if (!event.detail?.handled) return;

    state.autoAlertCount += 1;
    state.lastAutoAlert = cleanText(event.detail.message);

    if (state.currentJob) {
      state.currentJob.failures += 1;
      await writeJob(state.currentJob);
    }

    setStatus(`삭제 중 사이트 오류 알림을 자동 확인했습니다.\n${state.lastAutoAlert}\n알림 ${state.autoAlertCount}회, 실패 ${state.currentJob?.failures || 0}개`);
  };

  const setStatus = (message) => {
    if (state.controls.status) {
      state.controls.status.textContent = message;
    }
  };

  const syncButtons = () => {
    if (!state.controls.start || !state.controls.stop || !state.controls.resume) return;
    state.controls.start.disabled = state.running || state.paused || state.hasStoredJob;
    state.controls.stop.disabled = !state.running && !state.paused && !state.hasStoredJob;
    state.controls.resume.disabled = state.running || !state.paused;
  };

  const collectItemText = (button) => {
    const item = button.closest("li, tr, .cont, .reply, .scrap");
    if (!item) return "항목";
    return item.textContent.replace(/\s+/g, " ").trim().slice(0, 90) || "항목";
  };

  const runDeleteLoop = async (job) => {
    if (state.running) return;

    const activeJob = normalizeJob(job);
    if (!activeJob || activeJob.remaining <= 0) {
      await clearJob();
      syncButtons();
      return;
    }

    if (activeJob.paused) {
      showPausedJob(activeJob);
      return;
    }

    const options = activeJob.options;

    state.running = true;
    state.stopped = false;
    state.stopReason = "";
    state.recaptchaNotified = false;
    state.paused = false;
    state.currentJob = activeJob;
    state.autoAlertCount = 0;
    state.lastAutoAlert = "";
    state.deleted = activeJob.attempted;
    state.failures = activeJob.failures;
    await setConfirmBypass(true);
    syncButtons();

    let movingToNextPage = false;

    try {
      while (!state.stopped && activeJob.remaining > 0) {
        if (await stopIfRecaptchaDetected(activeJob)) {
          break;
        }

        const rawButtons = findRawDeleteButtons();
        const buttons = findDeleteButtons(options);

        if (buttons.length === 0) {
          let nextDebug = "";
          if (options.autoNextPage) {
            const next = findNextPageLink();
            if (next) {
              movingToNextPage = true;
              await writeJob(activeJob);
              setStatus(`현재 페이지 필터 후보 없음.\n다음 페이지로 이동합니다. 삭제 시도 ${activeJob.attempted}개`);
              next.click();
              return;
            }

            nextDebug = `\n다음 페이지 링크를 찾지 못했습니다.\n${getPaginationDebugText()}`;
          }

          await clearJob();
          const reason = rawButtons.length > 0
            ? "필터 조건에 맞는 삭제 후보가 없습니다."
            : "삭제 버튼을 찾지 못했습니다.";
          setStatus(`${reason}${nextDebug}\n삭제 시도 ${activeJob.attempted}개, 실패 ${activeJob.failures}개`);
          break;
        }

        const button = buttons[0];
        const item = button.closest("li, tr, .cont, .reply, .scrap");
        const label = collectItemText(button);
        const galleryLabel = getButtonGalleryLabel(button);
        setStatus(`삭제 시도 중: [${galleryLabel}] ${label}\n삭제 시도 ${activeJob.attempted}/${options.limit}, 남은 ${activeJob.remaining}개`);

        try {
          if (item) {
            item.dataset.gcClicked = "true";
          }

          activeJob.remaining -= 1;
          activeJob.attempted += 1;
          activeJob.paused = false;
          activeJob.pauseReason = "";
          await writeJob(activeJob);
          button.click();
        } catch (error) {
          activeJob.failures += 1;
          await writeJob(activeJob);
        }

        await sleep(options.delayMs);
      }

      if (activeJob.remaining <= 0 || (state.stopped && state.stopReason !== "recaptcha")) {
        await clearJob();
      }
    } finally {
      await setConfirmBypass(false);
      state.running = false;
      if (state.stopReason !== "recaptcha") {
        state.currentJob = null;
        state.paused = false;
      }
      syncButtons();

      if (movingToNextPage) return;

      if (state.stopReason === "recaptcha") {
        return;
      }

      if (state.stopped) {
        setStatus(`중지됨.\n삭제 시도 ${activeJob.attempted}개, 실패 ${activeJob.failures}개`);
      } else if (activeJob.remaining <= 0) {
        setStatus(`완료.\n삭제 시도 ${activeJob.attempted}개, 실패 ${activeJob.failures}개`);
      }
    }
  };

  const startNewRun = async () => {
    if (await stopIfRecaptchaDetected()) {
      return;
    }

    const options = readOptionsFromControls();
    const job = createJob(options);

    await saveOptions(options);
    await writeJob(job);
    await runDeleteLoop(job);
  };

  const stopDeleteLoop = async () => {
    const wasRunning = state.running;
    state.stopped = true;
    state.stopReason = "manual";
    state.paused = false;
    state.currentJob = null;
    await clearJob();
    setStatus(wasRunning
      ? `중지 요청됨.\n현재 클릭이 끝나면 멈춥니다.`
      : `저장된 이전 실행을 취소했습니다.`);
    syncButtons();
  };

  const showPausedJob = (job) => {
    state.paused = true;
    state.currentJob = job;
    applyOptionsToControls(job.options);
    state.paused = true;
    syncButtons();
    setStatus(`리캡챠로 일시중지됨.\n남은 ${job.remaining}개, 삭제 시도 ${job.attempted}개\n확인을 마친 뒤 계속을 누르세요.`);
  };

  const resumePausedJob = async () => {
    const job = await readJob();

    if (!job || job.remaining <= 0) {
      state.paused = false;
      state.currentJob = null;
      syncButtons();
      setStatus("이어갈 작업이 없습니다.");
      return;
    }

    if (!jobMatchesCurrentScope(job)) {
      setStatus("다른 갤로그 섹션의 작업이라 여기서 계속할 수 없습니다.");
      return;
    }

    if (getRecaptchaSignal()) {
      showPausedJob(job);
      setStatus(`아직 리캡챠 확인 화면이 감지됩니다.\n확인을 완료한 뒤 계속을 다시 누르세요.`);
      return;
    }

    job.paused = false;
    job.pauseReason = "";
    await writeJob(job);
    state.paused = false;
    state.currentJob = null;
    syncButtons();

    setStatus(`일시중지된 작업을 이어갑니다.\n남은 ${job.remaining}개, 삭제 시도 ${job.attempted}개`);
    await sleep(job.options.delayMs);
    await runDeleteLoop(job);
  };

  const resumePendingJob = async () => {
    const job = await readJob();
    syncButtons();

    if (!job || job.remaining <= 0) return;

    if (!jobMatchesCurrentScope(job)) {
      setStatus("다른 갤로그 섹션의 이전 실행이 남아 있어 자동 재개하지 않았습니다.\n중지/취소 버튼으로 이전 실행을 지울 수 있습니다.");
      return;
    }

    if (job.paused && job.pauseReason === "recaptcha") {
      showPausedJob(job);
      return;
    }

    if (await stopIfRecaptchaDetected(job)) {
      return;
    }

    applyOptionsToControls(job.options);

    setStatus(`이전 실행을 이어서 진행합니다.\n남은 ${job.remaining}개, 삭제 시도 ${job.attempted}개\n중지/취소로 재개를 취소할 수 있습니다.`);
    await sleep(job.options.delayMs);

    const latestJob = await readJob();
    if (!latestJob || latestJob.remaining <= 0) {
      setStatus("이전 실행이 취소되었습니다.");
      syncButtons();
      return;
    }

    if (!jobMatchesCurrentScope(latestJob)) {
      setStatus("다른 갤로그 섹션의 이전 실행이 남아 있어 자동 재개하지 않았습니다.\n중지/취소 버튼으로 이전 실행을 지울 수 있습니다.");
      syncButtons();
      return;
    }

    await runDeleteLoop(latestJob);
  };

  const preview = () => {
    const options = readOptionsFromControls();
    const rawButtons = findRawDeleteButtons();
    const buttons = findDeleteButtons(options);
    const lines = buttons.slice(0, 5).map((button, index) => {
      const galleryLabel = getButtonGalleryLabel(button);
      return `${index + 1}. [${galleryLabel}] ${collectItemText(button)}`;
    });

    if (lines.length === 0) {
      setStatus(rawButtons.length > 0
        ? "현재 페이지에 삭제 버튼은 있지만 필터 조건에 맞는 후보가 없습니다."
        : "현재 페이지에서 삭제 버튼을 찾지 못했습니다.");
      return;
    }

    const selectedCount = options.selectedGalleryIds.length;
    const filterText = selectedCount > 0
      ? `${options.galleryMode === "exclude" ? "제외" : "포함"} 필터 ${selectedCount}개 적용`
      : "갤러리 필터 없음";
    setStatus(`현재 페이지 삭제 후보 ${buttons.length}개 (${filterText})\n${lines.join("\n")}`);
  };

  const createPanel = async () => {
    await ensureInjected();

    if (state.panel) {
      state.panel.hidden = false;
      return;
    }

    const options = await readOptions();
    const panel = document.createElement("aside");
    panel.id = "gc-panel";
    panel.innerHTML = `
      <div class="gc-head">
        <div class="gc-title">Gallog Cleaner</div>
        <button class="gc-icon-btn" type="button" data-gc-close aria-label="닫기">×</button>
      </div>
      <div class="gc-body">
        <div class="gc-row">
          <label for="gc-limit">이번 실행</label>
          <input id="gc-limit" type="number" min="1" max="100000" step="1">
        </div>
        <div class="gc-row">
          <label for="gc-delay">삭제 간격 ms</label>
          <input id="gc-delay" type="number" min="500" max="10000" step="100">
        </div>
        <div class="gc-row">
          <label for="gc-next">다음 페이지</label>
          <input id="gc-next" type="checkbox">
        </div>
        <div class="gc-section">
          <label class="gc-block-label" for="gc-gallery-picker">갤러리 필터</label>
          <select id="gc-gallery-picker"></select>
          <div class="gc-block-label">선택된 갤러리</div>
          <div class="gc-chips" data-gc-selected-galleries></div>
          <div class="gc-block-label">필터 방식</div>
          <div class="gc-radio-row">
            <label><input id="gc-mode-include" name="gc-gallery-mode" type="radio" value="include"> 선택한 갤러리만 삭제</label>
            <label><input id="gc-mode-exclude" name="gc-gallery-mode" type="radio" value="exclude"> 선택한 갤러리는 제외</label>
          </div>
          <button class="gc-wide-btn gc-muted-btn" type="button" data-gc-refresh-galleries>목록 새로고침</button>
        </div>
        <div class="gc-actions">
          <button type="button" data-gc-start>시작</button>
          <button type="button" data-gc-stop disabled>중지/취소</button>
          <button type="button" data-gc-resume disabled>계속</button>
        </div>
        <button class="gc-wide-btn" type="button" data-gc-preview>삭제 후보 미리보기</button>
        <div class="gc-status" data-gc-status>먼저 미리보기로 삭제 후보를 확인하세요.</div>
        <div class="gc-small">삭제는 되돌릴 수 없습니다. 기본값은 안전하게 1개만 삭제합니다.</div>
      </div>
    `;

    document.documentElement.append(panel);

    state.panel = panel;
    state.controls = {
      limit: panel.querySelector("#gc-limit"),
      delay: panel.querySelector("#gc-delay"),
      autoNextPage: panel.querySelector("#gc-next"),
      galleryPicker: panel.querySelector("#gc-gallery-picker"),
      selectedGalleries: panel.querySelector("[data-gc-selected-galleries]"),
      galleryModeInclude: panel.querySelector("#gc-mode-include"),
      galleryModeExclude: panel.querySelector("#gc-mode-exclude"),
      start: panel.querySelector("[data-gc-start]"),
      stop: panel.querySelector("[data-gc-stop]"),
      resume: panel.querySelector("[data-gc-resume]"),
      status: panel.querySelector("[data-gc-status]")
    };

    state.galleries = collectGalleryOptions();
    applyOptionsToControls(options);

    panel.querySelector("[data-gc-close]").addEventListener("click", () => {
      panel.hidden = true;
    });
    state.controls.galleryPicker.addEventListener("change", () => {
      const id = state.controls.galleryPicker.value;
      if (id) {
        state.selectedGalleryIds.add(id);
        renderGalleryPicker();
      }
    });
    state.controls.selectedGalleries.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-gallery-id]");
      if (!chip) return;

      state.selectedGalleryIds.delete(chip.dataset.galleryId);
      renderGalleryPicker();
    });
    panel.querySelector("[data-gc-refresh-galleries]").addEventListener("click", refreshGalleryOptions);
    state.controls.start.addEventListener("click", startNewRun);
    state.controls.stop.addEventListener("click", stopDeleteLoop);
    state.controls.resume.addEventListener("click", resumePausedJob);
    panel.querySelector("[data-gc-preview]").addEventListener("click", preview);
    window.addEventListener("GC_PAGE_ALERT", handlePageAlert);

    startRecaptchaWatcher();
    resumePendingJob();
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "GC_OPEN_PANEL") {
      createPanel();
    }
  });

  createPanel();
})();
