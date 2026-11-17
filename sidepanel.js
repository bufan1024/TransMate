import { DEFAULT_SETTINGS, TARGET_LANGUAGES, validateSettings } from "./lib/config.js";
import { createPageSummaryPanel } from "./lib/page-summary-panel.js";
import { compareSelections, selectionStorageKey, selectionStoragePrefix, selectionWindowIdFromKey, shouldAcceptSelection } from "./lib/selection.js";
import { MAX_LONG_TEXT_LENGTH, splitLongText } from "./lib/long-translation.js";
import { MAX_TEXT_LENGTH, translate } from "./lib/translator.js";

const TRANSLATION_SETTING_KEYS = ["provider", "endpoint", "apiKey", "model", "targetLanguage", "prompt"];
const elements = {
  input: document.querySelector("#source-text"),
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
let requestNumber = 0;
let currentWindowId = null;
let settingsChangeVersion = 0;
const queuedSelections = new Map();
const summaryPanel = createPageSummaryPanel(chrome, document, normalizedSettings);

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
  elements.count.textContent = `${length.toLocaleString("zh-CN")} 字`;
  elements.count.style.color = overLimit ? "#9e3524" : "";
  elements.sourcePlan.hidden = !overLimit && !chunkCount;
  if (overLimit) {
    elements.sourcePlan.textContent = `原文最多支持 ${MAX_LONG_TEXT_LENGTH.toLocaleString("zh-CN")} 字符，请缩短后翻译。`;
  } else if (chunkCount) {
    const plan = completedCount
      ? `已完成 ${completedCount}/${chunkCount} 段，继续翻译将发送 ${remaining} 次请求。`
      : `将按原文顺序分 ${chunkCount} 段翻译，共发送 ${chunkCount} 次请求。`;
    elements.sourcePlan.textContent = `${plan}费用由 AI 服务决定。`;
  } else {
    elements.sourcePlan.textContent = "";
  }
  elements.translateLabel.textContent = completedCount ? "继续翻译" : "开始翻译";
  elements.clear.disabled = length === 0;
  const consumingSelection = Boolean(pendingSelection || consumingSelectionId);
  elements.translate.disabled = busy || consumingSelection || !length || overLimit || !ready;
  elements.translate.hidden = busy;
  elements.stop.hidden = !busy;
  elements.retry.disabled = busy || consumingSelection || !currentText || !ready;
  elements.copy.disabled = !translation;
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
  if (kind === "loading") elements.loadingProgress.textContent = value || "正在翻译…";
  if (kind === "stopped") {
    elements.stopped.textContent = longJob
      ? `翻译已停止，已完成 ${longJob.completed.length}/${longJob.chunks.length} 段。`
      : "翻译已停止";
  }
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
  if (kind !== "stopped") {
    currentText = "";
    longJob = null;
  }
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
  if (trimmed.length > MAX_LONG_TEXT_LENGTH) {
    showResult("error", `原文最多支持 ${MAX_LONG_TEXT_LENGTH.toLocaleString("zh-CN")} 字符，请缩短后翻译。`);
    return;
  }
  const config = normalizedSettings(effectiveTarget());
  if (!config) {
    elements.banner.hidden = false;
    showResult("error", "请先在设置中填写 AI 服务、模型和 API Key。");
    return;
  }

  if (trimmed.length > MAX_TEXT_LENGTH && longJob?.text !== trimmed) {
    longJob = { text: trimmed, chunks: splitLongText(trimmed), completed: [] };
  }
  const job = trimmed.length > MAX_TEXT_LENGTH ? longJob : null;
  const chunks = job?.chunks || [{ text: trimmed, separator: "" }];
  let index = job?.completed.length || 0;
  const controller = new AbortController();
  const request = { controller, timeoutId: null };
  const thisRequest = ++requestNumber;
  activeRequest = request;
  currentText = trimmed;
  translation = "";
  elements.copyLabel.textContent = "复制译文";
  showResult("loading");
  updateControls();

  let timedOut = false;
  try {
    let result = "";
    for (; index < chunks.length; index += 1) {
      if (job) showResult("loading", `正在翻译第 ${index + 1}/${chunks.length} 段…`);
      request.timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 45_000);
      try {
        result = await translate({
          text: chunks[index].text, settings: config, signal: controller.signal, requireComplete: Boolean(job),
        });
      } finally {
        clearTimeout(request.timeoutId);
      }
      if (thisRequest !== requestNumber) return;
      if (timedOut) throw new Error("连接超时");
      if (job) job.completed.push(result);
    }
    translation = job
      ? job.completed.map((part, position) => part + chunks[position].separator).join("")
      : result;
    longJob = null;
    showResult("success", translation);
  } catch (error) {
    if (thisRequest !== requestNumber) return;
    const message = timedOut ? "连接超时（45 秒）。请检查服务状态后重试。" : errorMessage(error);
    showResult("error", job ? `第 ${index + 1}/${chunks.length} 段未完成。${message}` : message);
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
      showResult("error", "无法清理选文状态。请编辑原文后再手动翻译。");
    }
  }).finally(() => {
    if (consumingSelectionId === selected.id) consumingSelectionId = null;
  });
}

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
    const [storedSettings, session] = await Promise.all([
      chrome.storage.local.get("settings"),
      chrome.storage.session.get(null),
    ]);
    if (settingsChangeVersion === initialSettingsChangeVersion) {
      settings = { ...DEFAULT_SETTINGS, ...(storedSettings.settings || {}) };
    }
    updateControls();
    summaryPanel.initialize(currentWindowId, session);
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
