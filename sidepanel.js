import { DEFAULT_SETTINGS, TARGET_LANGUAGES, validateSettings } from "./lib/config.js";
import { createPageSummaryPanel } from "./lib/page-summary-panel.js";
import { compareSelections, selectionStorageKey, selectionStoragePrefix, selectionWindowIdFromKey, shouldAcceptSelection } from "./lib/selection.js";
import { createHistoryPanel } from "./lib/history-panel.js";
import { HISTORY_KEY, recordTranslation } from "./lib/translation-history.js";
import { translate } from "./lib/translator.js";

const MAX_TEXT_LENGTH = 5000;
const TRANSLATION_SETTING_KEYS = ["provider", "endpoint", "apiKey", "model", "targetLanguage", "prompt"];
const elements = {
  input: document.querySelector("#source-text"),
  editor: document.querySelector("#source-editor"),
  layout: document.querySelector("#translation-layout"),
  comparison: document.querySelector("#compare-translation"),
  comparisonSource: document.querySelector("#comparison-source"),
  count: document.querySelector("#source-count"),
  target: document.querySelector("#target-language"),
  defaultTarget: document.querySelector("#target-label"),
  handoffTarget: document.querySelector("#handoff-target"),
  translate: document.querySelector("#translate-button"),
  stop: document.querySelector("#stop-button"),
  clear: document.querySelector("#clear-source"),
  retry: document.querySelector("#retry-button"),
  copy: document.querySelector("#copy-button"),
  copyLabel: document.querySelector("#copy-label"),
  state: document.querySelector("#result-state"),
  empty: document.querySelector("#result-empty"),
  loading: document.querySelector("#result-loading"),
  stopped: document.querySelector("#result-stopped"),
  result: document.querySelector("#result-text"),
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
let currentText = "";
let translation = "";
let comparing = false;
let requestNumber = 0;
let currentWindowId = null;
let settingsChangeVersion = 0;
const queuedSelections = new Map();
const summaryPanel = createPageSummaryPanel(chrome, document, normalizedSettings);
const historyPanel = createHistoryPanel(chrome, document);

function openSettings() {
  chrome.runtime.openOptionsPage();
}

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

function setComparisonMode(enabled) {
  if (comparing === enabled) return;
  comparing = enabled;
  elements.layout.classList.toggle("comparison-active", enabled);
  elements.editor.hidden = enabled;
  elements.comparisonSource.hidden = !enabled;
  elements.comparisonSource.textContent = enabled ? elements.input.value : "";
  elements.comparison.setAttribute("aria-pressed", String(enabled));
  elements.comparison.textContent = enabled ? "返回编辑" : "对照阅读";
}

function updateControls() {
  const length = elements.input.value.length;
  const ready = Boolean(normalizedSettings(effectiveTarget()));
  const busy = Boolean(activeRequest);
  const focused = document.activeElement;
  elements.count.textContent = `${length.toLocaleString("zh-CN")} 字`;
  elements.count.style.color = length > MAX_TEXT_LENGTH ? "#9e3524" : "";
  elements.clear.disabled = length === 0;
  const consumingSelection = Boolean(pendingSelection || consumingSelectionId);
  elements.translate.disabled = busy || consumingSelection || !length || length > MAX_TEXT_LENGTH || !ready;
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
  elements.defaultTarget.textContent = defaultName ? `${defaultName}（默认）` : "设置中的默认语言";
  elements.handoffTarget.hidden = !legacyTarget;
  elements.handoffTarget.value = legacyTarget?.targetLanguageId || "";
  elements.handoffTarget.textContent = legacyTarget?.targetLanguage || "";
  if (elements.target.value !== temporaryTarget) elements.target.value = temporaryTarget;
  elements.banner.hidden = ready;
  elements.bannerMessage.textContent = "先配置 AI 服务，即可开始翻译。";
  if (busy && (focused === elements.translate || focused === elements.retry)) elements.stop.focus();
  if (!busy && focused === elements.stop) {
    (elements.translate.disabled ? elements.input : elements.translate).focus();
  }
}

function showResult(kind, value = "") {
  elements.empty.hidden = kind !== "empty";
  elements.loading.hidden = kind !== "loading";
  elements.stopped.hidden = kind !== "stopped";
  elements.result.hidden = kind !== "success";
  elements.error.hidden = kind !== "error";
  elements.state.textContent = {
    empty: "等待输入", loading: "翻译中", stopped: "已停止", success: "已完成", error: "遇到问题",
  }[kind];
  if (kind === "success") elements.result.textContent = value;
  if (kind === "error") elements.errorMessage.textContent = value;
}

function translationSettingsChanged(nextSettings, targetOverride = "") {
  return TRANSLATION_SETTING_KEYS.some((key) => (key !== "targetLanguage" || !targetOverride)
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
  if (kind !== "stopped") currentText = "";
  elements.result.textContent = "";
  elements.copyLabel.textContent = "复制译文";
  showResult(kind);
}

function errorMessage(error) {
  const message = error?.message || String(error);
  if (error?.name === "AbortError") return "翻译已取消。";
  if (/permission|host|access|fetch|network/i.test(message)) return "无法连接到 AI 服务。请检查接口地址、网络和网站访问权限。";
  return message;
}

async function runTranslation(text) {
  if (activeRequest || pendingSelection || consumingSelectionId) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.length > MAX_TEXT_LENGTH) {
    showResult("error", `原文超过 ${MAX_TEXT_LENGTH.toLocaleString("zh-CN")} 字，请缩短后重试。`);
    return;
  }
  const config = normalizedSettings(effectiveTarget());
  if (!config) {
    elements.banner.hidden = false;
    showResult("error", "请先在设置中填写 AI 服务、模型和 API Key。");
    return;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);
  const thisRequest = ++requestNumber;
  activeRequest = { controller, timeoutId };
  currentText = trimmed;
  translation = "";
  elements.copyLabel.textContent = "复制译文";
  showResult("loading");
  updateControls();

  try {
    const result = await translate({ text: trimmed, settings: config, signal: controller.signal });
    if (thisRequest !== requestNumber) return;
    translation = result;
    showResult("success", result);
    void recordTranslation(chrome.storage.local, globalThis.navigator?.locks, {
      source: trimmed, translation: result, targetLanguage: config.targetLanguage,
    }).catch(() => {});
  } catch (error) {
    if (thisRequest !== requestNumber) return;
    if (timedOut) showResult("error", "连接超时（45 秒）。请检查服务状态后重试。");
    else if (error?.name !== "AbortError") showResult("error", errorMessage(error));
  } finally {
    clearTimeout(timeoutId);
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
  if (!selected.result && !normalizedSettings(effectiveTarget())) return;
  consumingSelectionId = selected.id;
  // Remove the event before displaying its result or translating its text. A
  // newer event has a separate key and can still supersede this operation.
  chrome.storage.session.remove(selected.storageKey).then(() => {
    if (pendingSelection?.id !== selected.id || newestSelection?.id !== selected.id
        || (!selected.result && !normalizedSettings(effectiveTarget()))) return;
    handledSelectionId = selected.id;
    pendingSelection = null;
    consumingSelectionId = null;
    if (selected.result) {
      const { targetLanguageId } = selected.result;
      if (effectiveTarget() !== targetLanguageId) temporaryTarget = targetLanguageId;
      legacyTarget = temporaryTarget && !TARGET_LANGUAGES.some(({ id }) => id === temporaryTarget)
        ? { targetLanguageId, targetLanguage: selected.result.targetLanguage } : null;
      currentText = selected.text;
      translation = selected.result.translation;
      showResult("success", translation);
      updateControls();
    } else {
      runTranslation(selected.text);
    }
  }).catch(() => {
    if (pendingSelection?.id === selected.id) {
      showResult("error", "无法清理选文状态。请编辑原文后再手动翻译。");
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
  if (elements.input.value.length > MAX_TEXT_LENGTH) {
    showResult("error", `原文超过 ${MAX_TEXT_LENGTH.toLocaleString("zh-CN")} 字，请缩短后重试。`);
  }
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
  if (previousTarget !== effectiveTarget() && (activeRequest || translation)) {
    const text = currentText;
    invalidateTranslation();
    runTranslation(text);
  } else {
    updateControls();
    consumePendingSelection();
  }
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
    elements.copyLabel.textContent = "已复制";
    setTimeout(() => {
      if (copiedRequest === requestNumber) elements.copyLabel.textContent = "复制译文";
    }, 1800);
  } catch {
    if (copiedRequest === requestNumber) elements.copyLabel.textContent = "复制失败";
  }
});
document.querySelector("#open-settings").addEventListener("click", openSettings);
document.querySelector("#banner-settings").addEventListener("click", openSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[HISTORY_KEY]) historyPanel.receive(changes[HISTORY_KEY].newValue);
  if (area === "local" && changes.settings) {
    settingsChangeVersion += 1;
    const nextSettings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    if (translationSettingsChanged(nextSettings, temporaryTarget)) invalidateTranslation();
    if (translationSettingsChanged(nextSettings)) summaryPanel.reset();
    settings = nextSettings;
    updateControls();
    consumePendingSelection();
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
      chrome.storage.local.get(["settings", HISTORY_KEY]),
      chrome.storage.session.get(null),
    ]);
    if (settingsChangeVersion === initialSettingsChangeVersion) {
      settings = { ...DEFAULT_SETTINGS, ...(storedSettings.settings || {}) };
    }
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
    showResult("error", `无法读取扩展设置：${errorMessage(error)}`);
  }
}

const targetOptions = document.querySelector("#target-options");
for (const { id, name } of TARGET_LANGUAGES) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = name;
  targetOptions.append(option);
}

showResult("empty");
updateControls();
initialize();
