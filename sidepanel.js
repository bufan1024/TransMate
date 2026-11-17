import { localizeDocument, message as localize } from './lib/i18n.js';
import { DEFAULT_SETTINGS, TARGET_LANGUAGES, defaultAuthTypeForProvider, validateSettings } from "./lib/config.js";
import { GLOSSARY_STORAGE_KEY, glossaryAffectsTranslations } from "./lib/glossary.js";
import { createLocalPdfPanel } from "./lib/local-pdf-panel.js";
import { MAX_LONG_TEXT_LENGTH, splitLongText } from "./lib/long-translation.js";
import { PAGE_SUMMARY_MENU, PAGE_TRANSLATION_MENU, PANEL_PAGE_ACTION } from "./lib/page-actions.js";
import { SERVICE_PROFILES_KEY, activateServiceProfile, normalizeServiceProfiles, profileOrigin } from "./lib/settings-management.js";
import { createPageSummaryPanel } from "./lib/page-summary-panel.js";
import { compareSelections, selectionStorageKey, selectionStoragePrefix, selectionWindowIdFromKey, shouldAcceptSelection } from "./lib/selection.js";
import { createHistoryPanel } from "./lib/history-panel.js";
import { HISTORY_KEY, recordTranslation } from "./lib/translation-history.js";
import { MAX_TEXT_LENGTH, translate } from "./lib/translator.js";

localizeDocument();

const TRANSLATION_SETTING_KEYS = ["provider", "endpoint", "apiKey", "workspaceId", "model", "targetLanguage", "prompt"];
const elements = {
  serviceSwitcher: document.querySelector("#service-switcher"),
  serviceProfile: document.querySelector("#service-profile"),
  serviceStatus: document.querySelector("#service-profile-status"),
  input: document.querySelector("#source-text"),
  editor: document.querySelector("#source-editor"),
  layout: document.querySelector("#translation-layout"),
  comparison: document.querySelector("#compare-translation"),
  comparisonSource: document.querySelector("#comparison-source"),
  count: document.querySelector("#source-count"),
  sourcePlan: document.querySelector("#source-plan"),
  target: document.querySelector("#target-language"),
  defaultTarget: document.querySelector("#target-label"),
  handoffTarget: document.querySelector("#handoff-target"),
  translate: document.querySelector("#translate-button"),
  translateLabel: document.querySelector("#translate-label"),
  stop: document.querySelector("#stop-button"),
  clear: document.querySelector("#clear-source"),
  retry: document.querySelector("#retry-button"),
  copy: document.querySelector("#copy-button"),
  copyLabel: document.querySelector("#copy-label"),
  state: document.querySelector("#result-state"),
  empty: document.querySelector("#result-empty"),
  loading: document.querySelector("#result-loading"),
  loadingProgress: document.querySelector("#loading-progress"),
  stopped: document.querySelector("#result-stopped"),
  result: document.querySelector("#result-text"),
  preview: document.querySelector("#result-preview"),
  error: document.querySelector("#result-error"),
  errorMessage: document.querySelector("#error-message"),
  banner: document.querySelector("#connection-banner"),
  bannerMessage: document.querySelector("#connection-message"),
};

let settings = { ...DEFAULT_SETTINGS };
let temporaryTarget = "";
let legacyTarget = null;
let pendingSelection = null;
let handledSelectionId = null;
let consumingSelectionId = null;
let newestSelection = null;
let activeRequest = null;
let longJob = null;
let currentText = "";
let translation = "";
let comparing = false;
let requestNumber = 0;
let currentWindowId = null;
let settingsChangeVersion = 0;
let glossary;
let glossaryChangeVersion = 0;
let profileChangeVersion = 0;
let activeProfileId = null;
let profileChoices = [];
let switchingProfile = false;
const queuedSelections = new Map();
const summaryPanel = createPageSummaryPanel(chrome, document, normalizedSettings);
const historyPanel = createHistoryPanel(chrome, document);

function openSettings() {
  chrome.runtime.openOptionsPage();
}

function updateProfileChoice() {
  elements.serviceProfile.value = activeProfileId ?? "";
  elements.serviceProfile.disabled = switchingProfile;
}

function renderServiceProfiles(stored) {
  const state = normalizeServiceProfiles(stored);
  activeProfileId = state.activeId;
  profileChoices = state.profiles.map((profile) => ({
    id: profile.id, name: profile.name, origin: profileOrigin(profile),
  }));
  elements.serviceSwitcher.hidden = profileChoices.length < 2;
  if (elements.serviceSwitcher.hidden) return;
  const options = profileChoices.map(({ id, name, origin }) => {
    const option = new Option(name, id);
    option.disabled = !origin;
    return option;
  });
  elements.serviceProfile.replaceChildren(...options);
  updateProfileChoice();
}

elements.serviceProfile.addEventListener("change", async () => {
  if (switchingProfile) return;
  const profile = profileChoices.find(({ id }) => id === elements.serviceProfile.value);
  if (!profile?.origin || profile.id === activeProfileId) {
    updateProfileChoice();
    return;
  }
  const lockManager = globalThis.navigator?.locks;
  if (typeof lockManager?.request !== "function") {
    elements.serviceStatus.textContent = localize('profileSwitchLocks', "当前浏览器无法安全切换配置，请升级 Chrome。");
    updateProfileChoice();
    return;
  }
  switchingProfile = true;
  elements.serviceProfile.disabled = true;
  elements.serviceStatus.textContent = localize('profileSwitchWorking', "正在切换配置…");
  try {
    // Preserve the dropdown gesture for a domain that was revoked manually.
    if (!await chrome.permissions.request({ origins: [profile.origin] })) {
      elements.serviceStatus.textContent = localize('profileSwitchPermission', "未获得该服务的访问权限。");
      return;
    }
    await activateServiceProfile({
      profileId: profile.id, expectedOrigin: profile.origin, storageArea: chrome.storage.local,
      permissionsApi: chrome.permissions, lockManager,
    });
    elements.serviceStatus.textContent = "";
  } catch {
    elements.serviceStatus.textContent = localize('profileSwitchFailed', "切换配置失败，请检查设置与域名授权。");
  } finally {
    switchingProfile = false;
    updateProfileChoice();
  }
});

function effectiveTarget() {
  const target = temporaryTarget || settings.targetLanguage;
  return typeof target === "string" ? target.trim() : target;
}

function normalizedSettings(targetLanguage = settings.targetLanguage) {
  try {
    return validateSettings({ ...settings, targetLanguage });
  } catch {
    return null;
  }
}

const pageActionButtons = [
  [document.querySelector("#translate-current-page"), PAGE_TRANSLATION_MENU],
  [document.querySelector("#summarize-current-page"), PAGE_SUMMARY_MENU],
];
const pageActionStatus = document.querySelector("#page-action-status");
let pageActionVersion = 0;

function setPageActionBusy(busy) {
  for (const [button] of pageActionButtons) button.disabled = busy;
}

async function runPageAction(action) {
  if (!normalizedSettings()) {
    pageActionStatus.textContent = localize('panelPageNeedsSettings', "请先在设置中配置 AI 服务。");
    return;
  }
  if (currentWindowId === null) {
    pageActionStatus.textContent = localize('panelPageUnavailableWindow', "无法确认当前窗口，请重新打开侧栏。");
    return;
  }
  const version = ++pageActionVersion;
  setPageActionBusy(true);
  pageActionStatus.textContent = localize('panelPageReading', "正在读取当前网页…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: PANEL_PAGE_ACTION, windowId: currentWindowId, action,
    });
    if (version !== pageActionVersion) return;
    if (response?.ok) {
      pageActionStatus.textContent = action === PAGE_TRANSLATION_MENU ? localize('panelPageStarted', "已在网页上启动双语翻译。") : "";
    } else {
      pageActionStatus.textContent = response?.error || localize('panelPageStartFailed', "无法启动网页操作，请从网页右键菜单重试。");
    }
  } catch {
    if (version === pageActionVersion) pageActionStatus.textContent = localize('panelPageStartFailed', "无法启动网页操作，请从网页右键菜单重试。");
  } finally {
    if (version === pageActionVersion) setPageActionBusy(false);
  }
}

for (const [button, action] of pageActionButtons) {
  button.addEventListener("click", () => runPageAction(action));
}

chrome.tabs?.onActivated?.addListener(({ windowId }) => {
  if (windowId !== currentWindowId) return;
  pageActionVersion += 1;
  pageActionStatus.textContent = "";
  setPageActionBusy(false);
});

function setComparisonMode(enabled) {
  if (comparing === enabled) return;
  comparing = enabled;
  elements.layout.classList.toggle("comparison-active", enabled);
  elements.editor.hidden = enabled;
  elements.comparisonSource.hidden = !enabled;
  elements.comparisonSource.textContent = enabled ? elements.input.value : "";
  elements.comparison.setAttribute("aria-pressed", String(enabled));
  elements.comparison.textContent = enabled ? localize('editOriginal', "返回编辑") : localize('readingComparison', "对照阅读");
}

function updateControls() {
  const text = elements.input.value.trim();
  const length = text.length;
  const overLimit = length > MAX_LONG_TEXT_LENGTH;
  const job = longJob?.text === text ? longJob : null;
  const chunkCount = length > MAX_TEXT_LENGTH && !overLimit
    ? (job?.chunks || splitLongText(text)).length : 0;
  const completedCount = job?.completed.length || 0;
  const remaining = chunkCount - completedCount;
  const ready = Boolean(normalizedSettings(effectiveTarget()));
  const busy = Boolean(activeRequest);
  const focused = document.activeElement;
  elements.count.textContent = localize('characterCount', `${length.toLocaleString("zh-CN")} 字`, length.toLocaleString("zh-CN"));
  elements.count.style.color = overLimit ? "#9e3524" : "";
  elements.sourcePlan.hidden = !overLimit && !chunkCount;
  if (overLimit) {
    elements.sourcePlan.textContent = longTextLimit();
  } else if (chunkCount && completedCount) {
    elements.sourcePlan.textContent = localize('longTextResumePlan',
      `已完成 ${completedCount}/${chunkCount} 段，继续翻译将发送 ${remaining} 次请求。费用由 AI 服务决定。`,
      completedCount, chunkCount, remaining);
  } else if (chunkCount) {
    elements.sourcePlan.textContent = localize('longTextPlan',
      `将按原文顺序分 ${chunkCount} 段翻译，共发送 ${chunkCount} 次请求。费用由 AI 服务决定。`, chunkCount);
  } else {
    elements.sourcePlan.textContent = "";
  }
  elements.translateLabel.textContent = completedCount
    ? localize('resumeLongTranslation', "继续翻译") : localize('startTranslation', "开始翻译");
  elements.clear.disabled = length === 0;
  const consumingSelection = Boolean(pendingSelection || consumingSelectionId);
  elements.translate.disabled = busy || consumingSelection || !length || overLimit || !ready;
  elements.translate.hidden = busy;
  elements.stop.hidden = !busy;
  elements.retry.disabled = busy || consumingSelection || !currentText || !ready;
  elements.copy.disabled = !translation;
  if (!translation && comparing) {
    setComparisonMode(false);
    if (document.activeElement === elements.comparison) elements.input.focus();
  }
  elements.comparison.hidden = !translation;
  const defaultTarget = typeof settings.targetLanguage === "string" ? settings.targetLanguage.trim() : "";
  const defaultName = TARGET_LANGUAGES.find(({ id }) => id === defaultTarget)?.name || defaultTarget;
  elements.defaultTarget.textContent = defaultName ? localize('defaultNamedLanguage', `${defaultName}（默认）`, defaultName) : localize('defaultLanguage', "设置中的默认语言");
  elements.handoffTarget.hidden = !legacyTarget;
  elements.handoffTarget.value = legacyTarget?.targetLanguageId || "";
  elements.handoffTarget.textContent = legacyTarget?.targetLanguage || "";
  if (elements.target.value !== temporaryTarget) elements.target.value = temporaryTarget;
  elements.banner.hidden = ready;
  elements.bannerMessage.textContent = localize('configureFirstBanner', "先配置 AI 服务，即可开始翻译。");
  if (busy && (focused === elements.translate || focused === elements.retry)) elements.stop.focus();
  if (!busy && focused === elements.stop) {
    (elements.translate.disabled ? elements.input : elements.translate).focus();
  }
}

function longTextLimit() {
  const limit = MAX_LONG_TEXT_LENGTH.toLocaleString("zh-CN");
  return localize('longTextLimit', `原文最多支持 ${limit} 字符，请缩短后翻译。`, limit);
}

function showResult(kind, value = "") {
  elements.empty.hidden = kind !== "empty";
  elements.loading.hidden = kind !== "loading";
  elements.preview.textContent = "";
  elements.preview.hidden = true;
  elements.stopped.hidden = kind !== "stopped";
  elements.result.hidden = kind !== "success";
  elements.error.hidden = kind !== "error";
  elements.state.textContent = {
    empty: localize('waitingForInput', "等待输入"), loading: localize('inProgress', "翻译中"), stopped: localize('stopped', "已停止"), success: localize('complete', "已完成"), error: localize('errorState', "遇到问题"),
  }[kind];
  if (kind === "loading") {
    elements.loadingProgress.textContent = value || localize('workingTranslation', "正在斟酌字句…");
  }
  if (kind === "stopped") {
    const completed = longJob?.completed.length;
    const total = longJob?.chunks.length;
    elements.stopped.textContent = longJob
      ? localize('longTextStopped', `翻译已停止，已完成 ${completed}/${total} 段。`, completed, total)
      : localize('translationStopped', "翻译已停止");
  }
  if (kind === "success") elements.result.textContent = value;
  if (kind === "error") elements.errorMessage.textContent = value;
}

function translationSettingsChanged(nextSettings, targetOverride = "") {
  const authType = settings.authType ?? defaultAuthTypeForProvider(settings.provider);
  const nextAuthType = nextSettings.authType ?? defaultAuthTypeForProvider(nextSettings.provider);
  return authType !== nextAuthType || TRANSLATION_SETTING_KEYS.some((key) => (key !== "targetLanguage" || !targetOverride)
    && settings[key] !== nextSettings[key]);
}

function invalidateTranslation(kind = "empty") {
  requestNumber += 1;
  if (activeRequest) {
    activeRequest.controller.abort();
    clearTimeout(activeRequest.timeoutId);
    activeRequest = null;
  }
  translation = "";
  if (kind !== "stopped") {
    currentText = "";
    longJob = null;
  }
  elements.result.textContent = "";
  elements.copyLabel.textContent = localize('copyTranslation', "复制译文");
  showResult(kind);
}

function errorMessage(error) {
  const message = error?.message || String(error);
  if (error?.name === "AbortError") return localize('translationCancelled', "翻译已取消。");
  if (/permission|host|access|fetch|network/i.test(message)) return localize('serviceNetworkError', "无法连接到 AI 服务。请检查接口地址、网络和网站访问权限。");
  return message;
}

async function runTranslation(text) {
  if (activeRequest || pendingSelection || consumingSelectionId) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.length > MAX_LONG_TEXT_LENGTH) {
    showResult("error", longTextLimit());
    return;
  }
  const config = normalizedSettings(effectiveTarget());
  if (!config) {
    elements.banner.hidden = false;
    showResult("error", localize('openConfiguredService', "请先在设置中填写 AI 服务、模型和 API Key。"));
    return;
  }

  const isLong = trimmed.length > MAX_TEXT_LENGTH;
  if (isLong && longJob?.text !== trimmed) {
    longJob = { text: trimmed, chunks: splitLongText(trimmed), completed: [] };
  }
  const job = isLong ? longJob : null;
  const chunks = job?.chunks || [{ text: trimmed, separator: "" }];
  let index = job?.completed.length || 0;
  const controller = new AbortController();
  const request = { controller, timeoutId: null };
  const thisRequest = ++requestNumber;
  activeRequest = request;
  currentText = trimmed;
  translation = "";
  elements.copyLabel.textContent = localize('copyTranslation', "复制译文");
  showResult("loading");
  updateControls();

  const onDelta = job ? undefined : (delta) => {
    if (thisRequest !== requestNumber || controller.signal.aborted) return;
    elements.preview.append(delta);
    elements.preview.hidden = false;
  };
  let timedOut = false;
  try {
    let result = "";
    for (; index < chunks.length; index += 1) {
      if (job) {
        showResult("loading", localize('longTextProgress',
          `正在翻译第 ${index + 1}/${chunks.length} 段…`, index + 1, chunks.length));
      }
      request.timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 45_000);
      try {
        result = await translate({
          text: chunks[index].text, settings: config, glossary, signal: controller.signal, requireComplete: true, onDelta,
        });
      } finally {
        clearTimeout(request.timeoutId);
      }
      if (thisRequest !== requestNumber) return;
      if (timedOut) throw new Error("Translation timed out");
      if (job) job.completed.push(result);
    }
    translation = job
      ? job.completed.map((part, position) => part + chunks[position].separator).join("")
      : result;
    longJob = null;
    showResult("success", translation);
    void recordTranslation(chrome.storage.local, globalThis.navigator?.locks, {
      source: trimmed, translation, targetLanguage: config.targetLanguage,
    }).catch(() => {});
  } catch (error) {
    if (thisRequest !== requestNumber) return;
    const message = timedOut ? localize('sidePanelConnectionTimeout', "连接超时（45 秒）。请检查服务状态后重试。") : errorMessage(error);
    showResult("error", job ? localize('longTextPartFailed',
      `第 ${index + 1}/${chunks.length} 段未完成。${message}`, index + 1, chunks.length, message) : message);
  } finally {
    if (thisRequest === requestNumber) {
      activeRequest = null;
      updateControls();
    }
  }
}

function discardSelection(key) {
  chrome.storage.session.remove(key).catch(() => {});
}

function acceptSelection(key, selection) {
  if (currentWindowId === null) {
    queuedSelections.set(key, selection);
    return;
  }
  if (!key.startsWith(selectionStoragePrefix(currentWindowId))) return;
  if (!shouldAcceptSelection(selection, currentWindowId)
      || key !== selectionStorageKey(currentWindowId, selection.id)) {
    discardSelection(key);
    return;
  }
  if (newestSelection && compareSelections(selection, newestSelection) <= 0) {
    if (selection.id !== newestSelection.id) discardSelection(key);
    return;
  }

  if (pendingSelection && pendingSelection.id !== consumingSelectionId) {
    discardSelection(pendingSelection.storageKey);
  }
  newestSelection = selection;
  pendingSelection = { ...selection, storageKey: key };
  elements.input.value = selection.text;
  invalidateTranslation();
  updateControls();
  consumePendingSelection();
}

function consumePendingSelection() {
  if (!pendingSelection || pendingSelection.id === handledSelectionId
      || pendingSelection.id === consumingSelectionId) return;
  if (!shouldAcceptSelection(pendingSelection, currentWindowId)) {
    discardSelection(pendingSelection.storageKey);
    pendingSelection = null;
    updateControls();
    return;
  }
  const selected = pendingSelection;
  const needsTranslation = !selected.result && selected.text.trim().length <= MAX_TEXT_LENGTH;
  if (needsTranslation && !normalizedSettings(effectiveTarget())) return;
  consumingSelectionId = selected.id;
  // Remove the event before displaying its result or translating its text. A
  // newer event has a separate key and can still supersede this operation.
  chrome.storage.session.remove(selected.storageKey).then(() => {
    if (pendingSelection?.id !== selected.id || newestSelection?.id !== selected.id
        || (needsTranslation && !normalizedSettings(effectiveTarget()))) return;
    handledSelectionId = selected.id;
    pendingSelection = null;
    consumingSelectionId = null;
    if (!shouldAcceptSelection(selected, currentWindowId)) {
      updateControls();
      return;
    }
    if (selected.result) {
      const { targetLanguageId } = selected.result;
      if (effectiveTarget() !== targetLanguageId) temporaryTarget = targetLanguageId;
      legacyTarget = temporaryTarget && !TARGET_LANGUAGES.some(({ id }) => id === temporaryTarget)
        ? { targetLanguageId, targetLanguage: selected.result.targetLanguage } : null;
      currentText = selected.text;
      translation = selected.result.translation;
      showResult("success", translation);
      updateControls();
    } else if (needsTranslation) {
      runTranslation(selected.text);
    } else {
      updateControls();
    }
  }).catch(() => {
    if (pendingSelection?.id === selected.id) {
      showResult("error", localize('pendingSelectionError', "无法清理选文状态。请编辑原文后再手动翻译。"));
    }
  }).finally(() => {
    if (consumingSelectionId === selected.id) consumingSelectionId = null;
  });
}

elements.comparison.addEventListener("click", () => {
  if (translation) setComparisonMode(!comparing);
});

elements.input.addEventListener("input", () => {
  if (pendingSelection) discardSelection(pendingSelection.storageKey);
  pendingSelection = null;
  consumingSelectionId = null;
  invalidateTranslation();
  updateControls();
});
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    runTranslation(elements.input.value);
  }
});
elements.translate.addEventListener("click", () => runTranslation(elements.input.value));
elements.stop.addEventListener("click", () => {
  if (!activeRequest) return;
  invalidateTranslation("stopped");
  updateControls();
});
elements.target.addEventListener("change", () => {
  const previousTarget = effectiveTarget();
  const selected = elements.target.value;
  if (!selected || TARGET_LANGUAGES.some(({ id }) => id === selected)) {
    temporaryTarget = selected;
    legacyTarget = null;
  }
  if (previousTarget !== effectiveTarget() && (activeRequest || translation || longJob)) {
    const text = currentText;
    invalidateTranslation();
    if (text.length <= MAX_TEXT_LENGTH) {
      runTranslation(text);
      return;
    }
  }
  updateControls();
  consumePendingSelection();
});
elements.retry.addEventListener("click", () => runTranslation(currentText));
elements.clear.addEventListener("click", () => {
  elements.input.value = "";
  elements.input.dispatchEvent(new Event("input"));
  elements.input.focus();
});
elements.copy.addEventListener("click", async () => {
  if (!translation) return;
  const copiedRequest = requestNumber;
  try {
    await navigator.clipboard.writeText(translation);
    if (copiedRequest !== requestNumber) return;
    elements.copyLabel.textContent = localize('copied', "已复制");
    setTimeout(() => {
      if (copiedRequest === requestNumber) elements.copyLabel.textContent = localize('copyTranslation', "复制译文");
    }, 1800);
  } catch {
    if (copiedRequest === requestNumber) elements.copyLabel.textContent = localize('copyFailed', "复制失败");
  }
});
document.querySelector("#open-settings").addEventListener("click", openSettings);
document.querySelector("#banner-settings").addEventListener("click", openSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[HISTORY_KEY]) historyPanel.receive(changes[HISTORY_KEY].newValue);
  if (area === "local" && (changes.settings || changes[GLOSSARY_STORAGE_KEY])) {
    const nextGlossary = changes[GLOSSARY_STORAGE_KEY];
    let invalidate = glossaryAffectsTranslations(nextGlossary);
    if (changes.settings) {
      settingsChangeVersion += 1;
      const nextSettings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      invalidate ||= translationSettingsChanged(nextSettings, temporaryTarget);
      if (translationSettingsChanged(nextSettings)) summaryPanel.reset();
      settings = nextSettings;
    }
    if (nextGlossary) {
      glossaryChangeVersion += 1;
      glossary = nextGlossary.newValue;
    }
    if (invalidate) invalidateTranslation();
    updateControls();
    consumePendingSelection();
  }
  if (area === "local" && changes[SERVICE_PROFILES_KEY]) {
    profileChangeVersion += 1;
    try {
      renderServiceProfiles({
        settings: changes.settings?.newValue,
        [SERVICE_PROFILES_KEY]: changes[SERVICE_PROFILES_KEY].newValue,
      });
    } catch {
      elements.serviceSwitcher.hidden = true;
    }
  }
  if (area === "session") {
    for (const [key, change] of Object.entries(changes)) {
      summaryPanel.receive(key, change.newValue);
      if (selectionWindowIdFromKey(key) !== null && change.newValue) {
        acceptSelection(key, change.newValue);
      }
    }
  }
});

async function initialize() {
  const initialSettingsChangeVersion = settingsChangeVersion;
  const initialProfileChangeVersion = profileChangeVersion;
  const initialGlossaryChangeVersion = glossaryChangeVersion;
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    try {
      const currentWindow = await chrome.windows.getCurrent();
      if (Number.isInteger(currentWindow.id)) currentWindowId = currentWindow.id;
    } catch {
      // Selection cannot be routed safely; manual translation remains available.
    }
    const historyVersion = historyPanel.version;
    const [storedSettings, session] = await Promise.all([
      chrome.storage.local.get(["settings", HISTORY_KEY, SERVICE_PROFILES_KEY, GLOSSARY_STORAGE_KEY]),
      chrome.storage.session.get(null),
    ]);
    if (settingsChangeVersion === initialSettingsChangeVersion) {
      settings = { ...DEFAULT_SETTINGS, ...(storedSettings.settings || {}) };
    }
    if (initialProfileChangeVersion === profileChangeVersion) renderServiceProfiles(storedSettings);
    if (initialGlossaryChangeVersion === glossaryChangeVersion) glossary = storedSettings[GLOSSARY_STORAGE_KEY];
    updateControls();
    summaryPanel.initialize(currentWindowId, session);
    historyPanel.initialize(storedSettings[HISTORY_KEY], historyVersion);
    if (currentWindowId !== null) {
      const prefix = selectionStoragePrefix(currentWindowId);
      const candidates = new Map([
        ...Object.entries(session).filter(([key]) => key.startsWith(prefix)),
        ...queuedSelections,
      ]);
      const valid = [];
      for (const [key, selection] of candidates) {
        if (!key.startsWith(prefix)) continue;
        if (shouldAcceptSelection(selection, currentWindowId)
            && key === selectionStorageKey(currentWindowId, selection.id)) {
          valid.push([key, selection]);
        } else {
          discardSelection(key);
        }
      }
      valid.sort((left, right) => compareSelections(left[1], right[1]));
      for (const [key] of valid.slice(0, -1)) discardSelection(key);
      const latest = valid.at(-1);
      if (latest) acceptSelection(...latest);
    }
    queuedSelections.clear();
    consumePendingSelection();
  } catch (error) {
    showResult("error", localize('extensionSettingsError', `无法读取扩展设置：${errorMessage(error)}`, errorMessage(error)));
  }
}

const targetOptions = document.querySelector("#target-options");
for (const { id, name } of TARGET_LANGUAGES) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = name;
  targetOptions.append(option);
}

createLocalPdfPanel(document, (snippet) => {
  elements.input.value = snippet;
  elements.input.dispatchEvent(new Event("input"));
  elements.input.focus();
});
showResult("empty");
updateControls();
initialize();
