import { DEFAULT_SETTINGS, validateSettings } from "./lib/config.js";
import { shouldAcceptSelection } from "./lib/selection.js";
import { translate } from "./lib/translator.js";

const MAX_TEXT_LENGTH = 5000;
const TRANSLATION_SETTING_KEYS = ["provider", "endpoint", "apiKey", "model", "targetLanguage", "prompt"];
const targetNames = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  en: "英语",
  ja: "日语",
  ko: "韩语",
  fr: "法语",
  de: "德语",
  es: "西班牙语",
};

const elements = {
  input: document.querySelector("#source-text"),
  count: document.querySelector("#source-count"),
  target: document.querySelector("#target-label"),
  translate: document.querySelector("#translate-button"),
  clear: document.querySelector("#clear-source"),
  retry: document.querySelector("#retry-button"),
  copy: document.querySelector("#copy-button"),
  copyLabel: document.querySelector("#copy-label"),
  state: document.querySelector("#result-state"),
  empty: document.querySelector("#result-empty"),
  loading: document.querySelector("#result-loading"),
  result: document.querySelector("#result-text"),
  error: document.querySelector("#result-error"),
  errorMessage: document.querySelector("#error-message"),
  banner: document.querySelector("#connection-banner"),
  bannerMessage: document.querySelector("#connection-message"),
};

let settings = { ...DEFAULT_SETTINGS };
let pendingSelection = null;
let handledSelectionId = null;
let activeController = null;
let currentText = "";
let translation = "";
let requestNumber = 0;
let busy = false;
let currentWindowId = null;
let queuedSelection = null;

function openSettings() {
  chrome.runtime.openOptionsPage();
}

function normalizedSettings() {
  try {
    return validateSettings(settings);
  } catch {
    return null;
  }
}

function updateControls() {
  const length = elements.input.value.length;
  const ready = Boolean(normalizedSettings());
  elements.count.textContent = `${length.toLocaleString("zh-CN")} 字`;
  elements.count.style.color = length > MAX_TEXT_LENGTH ? "#9e3524" : "";
  elements.clear.disabled = length === 0;
  elements.translate.disabled = busy || !length || length > MAX_TEXT_LENGTH || !ready;
  elements.retry.disabled = busy || !currentText || !ready;
  elements.copy.disabled = !translation;
  elements.target.textContent = `译为${targetNames[settings.targetLanguage] || settings.targetLanguage || "目标语言"}`;
  elements.banner.hidden = ready;
  elements.bannerMessage.textContent = "先配置 AI 服务，即可开始翻译。";
}

function showResult(kind, value = "") {
  elements.empty.hidden = kind !== "empty";
  elements.loading.hidden = kind !== "loading";
  elements.result.hidden = kind !== "success";
  elements.error.hidden = kind !== "error";
  elements.state.textContent = { empty: "等待输入", loading: "翻译中", success: "已完成", error: "遇到问题" }[kind];
  if (kind === "success") elements.result.textContent = value;
  if (kind === "error") elements.errorMessage.textContent = value;
}

function translationSettingsChanged(nextSettings) {
  return TRANSLATION_SETTING_KEYS.some((key) => settings[key] !== nextSettings[key]);
}

function invalidateTranslation() {
  requestNumber += 1;
  activeController?.abort();
  activeController = null;
  busy = false;
  translation = "";
  currentText = "";
  elements.result.textContent = "";
  elements.copyLabel.textContent = "复制译文";
  showResult("empty");
}

function errorMessage(error) {
  const message = error?.message || String(error);
  if (error?.name === "AbortError") return "翻译已取消。";
  if (/permission|host|access|fetch|network/i.test(message)) return "无法连接到 AI 服务。请检查接口地址、网络和网站访问权限。";
  return message;
}

async function runTranslation(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.length > MAX_TEXT_LENGTH) {
    showResult("error", `原文超过 ${MAX_TEXT_LENGTH.toLocaleString("zh-CN")} 字，请缩短后重试。`);
    return;
  }
  let config;
  try {
    config = validateSettings(settings);
  } catch {
    elements.banner.hidden = false;
    showResult("error", "请先在设置中填写 AI 服务、模型和 API Key。");
    return;
  }

  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);
  const thisRequest = ++requestNumber;
  currentText = trimmed;
  translation = "";
  busy = true;
  elements.copyLabel.textContent = "复制译文";
  showResult("loading");
  updateControls();

  try {
    const result = await translate({ text: trimmed, settings: config, signal: controller.signal });
    if (thisRequest !== requestNumber) return;
    translation = result;
    showResult("success", result);
  } catch (error) {
    if (thisRequest !== requestNumber) return;
    if (timedOut) showResult("error", "连接超时（45 秒）。请检查服务状态后重试。");
    else if (error?.name !== "AbortError") showResult("error", errorMessage(error));
  } finally {
    clearTimeout(timeoutId);
    if (thisRequest === requestNumber) {
      busy = false;
      activeController = null;
      updateControls();
    }
  }
}

function acceptSelection(selection) {
  if (currentWindowId === null) {
    queuedSelection = selection;
    return;
  }
  if (!shouldAcceptSelection(selection, currentWindowId)) return;
  if (selection.id === handledSelectionId) return;
  pendingSelection = selection;
  elements.input.value = selection.text;
  activeController?.abort();
  requestNumber += 1;
  activeController = null;
  busy = false;
  translation = "";
  currentText = "";
  showResult("empty");
  updateControls();
  maybeTranslateSelection();
}

function maybeTranslateSelection() {
  if (!pendingSelection || pendingSelection.id === handledSelectionId || !normalizedSettings()) return;
  if (!shouldAcceptSelection(pendingSelection, currentWindowId)) {
    pendingSelection = null;
    return;
  }
  const selectionId = pendingSelection.id;
  handledSelectionId = selectionId;
  // Consume the event so reopening the panel does not issue another paid request.
  chrome.storage.session.get("pendingSelection").then(({ pendingSelection: current }) => {
    if (current?.id === selectionId) return chrome.storage.session.remove("pendingSelection");
  }).catch(() => {});
  runTranslation(pendingSelection.text);
}

elements.input.addEventListener("input", () => {
  pendingSelection = null;
  activeController?.abort();
  requestNumber += 1;
  activeController = null;
  busy = false;
  translation = "";
  currentText = "";
  if (elements.input.value.length > MAX_TEXT_LENGTH) {
    showResult("error", `原文超过 ${MAX_TEXT_LENGTH.toLocaleString("zh-CN")} 字，请缩短后重试。`);
  } else {
    showResult("empty");
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
elements.retry.addEventListener("click", () => runTranslation(currentText));
elements.clear.addEventListener("click", () => {
  elements.input.value = "";
  elements.input.dispatchEvent(new Event("input"));
  elements.input.focus();
});
elements.copy.addEventListener("click", async () => {
  if (!translation) return;
  try {
    await navigator.clipboard.writeText(translation);
    elements.copyLabel.textContent = "已复制";
    setTimeout(() => { elements.copyLabel.textContent = "复制译文"; }, 1800);
  } catch {
    elements.copyLabel.textContent = "复制失败";
  }
});
document.querySelector("#open-settings").addEventListener("click", openSettings);
document.querySelector("#banner-settings").addEventListener("click", openSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    const nextSettings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    if (translationSettingsChanged(nextSettings)) invalidateTranslation();
    settings = nextSettings;
    updateControls();
    maybeTranslateSelection();
  }
  if (area === "session" && changes.pendingSelection?.newValue) acceptSelection(changes.pendingSelection.newValue);
});

async function initialize() {
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
      chrome.storage.session.get("pendingSelection"),
    ]);
    settings = { ...DEFAULT_SETTINGS, ...(storedSettings.settings || {}) };
    updateControls();
    const newestSelection = queuedSelection && (!session.pendingSelection || queuedSelection.createdAt >= session.pendingSelection.createdAt)
      ? queuedSelection : session.pendingSelection;
    acceptSelection(newestSelection);
    maybeTranslateSelection();
  } catch (error) {
    showResult("error", `无法读取扩展设置：${errorMessage(error)}`);
  }
}

showResult("empty");
updateControls();
initialize();
