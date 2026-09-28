import { DEFAULT_SETTINGS, PROVIDERS, originPatternForEndpoint, validateSettings } from "./lib/config.js";
import { checkConnection } from "./lib/connection-check.js";

const form = document.querySelector("#settings-form");
const providerList = document.querySelector("#provider-list");
const endpointInput = document.querySelector("#endpoint");
const apiKeyInput = document.querySelector("#api-key");
const modelInput = document.querySelector("#model");
const targetInput = document.querySelector("#target-language");
const promptInput = document.querySelector("#prompt");
const status = document.querySelector("#form-status");
const saveButton = document.querySelector("#save-settings");
const testButton = document.querySelector("#test-connection");
const toggleKey = document.querySelector("#toggle-key");
let previousProvider = DEFAULT_SETTINGS.provider;
let activeConnectionCheck = null;

function renderProviders() {
  for (const provider of PROVIDERS) {
    const label = document.createElement("label");
    label.className = "provider-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "provider";
    input.value = provider.id;
    const initial = document.createElement("span");
    initial.className = "provider-initial";
    initial.setAttribute("aria-hidden", "true");
    initial.textContent = provider.name.charAt(0).toUpperCase();
    const name = document.createElement("span");
    name.className = "provider-name";
    name.textContent = provider.name;
    label.append(input, initial, name);
    providerList.append(label);
  }
}

function selectedProvider() {
  return form.querySelector('input[name="provider"]:checked')?.value || DEFAULT_SETTINGS.provider;
}

function setProvider(id) {
  const input = form.querySelector(`input[name="provider"][value="${id}"]`);
  if (input) input.checked = true;
  previousProvider = selectedProvider();
}

function formSettings() {
  return {
    provider: selectedProvider(),
    endpoint: endpointInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    targetLanguage: targetInput.value,
    prompt: promptInput.value.trim(),
  };
}

function showStatus(message, tone) {
  status.textContent = message;
  status.dataset.tone = tone;
  status.hidden = false;
}

function setBusy(busy, mode = "save") {
  saveButton.disabled = busy;
  testButton.disabled = busy && mode !== "test";
  saveButton.querySelector("span:first-child").textContent = busy && mode === "save" ? "请稍候…" : "保存配置";
  testButton.querySelector(".test-label").textContent = busy && mode === "test" ? "取消检测" : busy ? "请稍候…" : "测试连接";
  testButton.dataset.testing = String(busy && mode === "test");
}

function cancelConnectionCheck(message = "连接检测已取消。") {
  if (!activeConnectionCheck) return;
  const check = activeConnectionCheck;
  activeConnectionCheck = null;
  check.controller.abort();
  setBusy(false);
  showStatus(message, "working");
}

function validationError(error) {
  const message = error?.message || String(error);
  if (/invalid url|endpoint|https|接口/i.test(message)) endpointInput.focus();
  else if (/api.?key/i.test(message)) apiKeyInput.focus();
  else if (/model|模型/i.test(message)) modelInput.focus();
  return message;
}

function requestEndpointPermission(endpoint) {
  // Call within the click/submit gesture, before any await.
  return chrome.permissions.request({ origins: [originPatternForEndpoint(endpoint)] });
}

function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === id);
}

providerList.addEventListener("change", (event) => {
  if (event.target.name !== "provider") return;
  const oldPreset = providerById(previousProvider)?.endpoint || "";
  const nextPreset = providerById(event.target.value)?.endpoint || "";
  if (!endpointInput.value.trim() || endpointInput.value.trim() === oldPreset) endpointInput.value = nextPreset;
  previousProvider = event.target.value;
  status.hidden = true;
});

toggleKey.addEventListener("click", () => {
  const reveal = apiKeyInput.type === "password";
  apiKeyInput.type = reveal ? "text" : "password";
  toggleKey.textContent = reveal ? "隐藏" : "显示";
  toggleKey.setAttribute("aria-label", reveal ? "隐藏 API Key" : "显示 API Key");
  toggleKey.setAttribute("aria-pressed", String(reveal));
});

function onFormChanged() {
  if (activeConnectionCheck) cancelConnectionCheck("配置已修改，连接检测已取消。请重新检测。");
  else status.hidden = true;
}
form.addEventListener("input", onFormChanged);
form.addEventListener("change", onFormChanged);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  let config;
  let permissionPromise;
  try {
    config = validateSettings(formSettings());
    permissionPromise = requestEndpointPermission(config.endpoint);
  } catch (error) {
    showStatus(validationError(error), "error");
    return;
  }

  setBusy(true);
  showStatus("正在申请访问此 AI 服务的权限…", "working");
  try {
    if (!(await permissionPromise)) {
      showStatus("未获得该服务的访问权限。请允许访问后再保存。", "error");
      return;
    }
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.local.set({ settings: config });
    showStatus("配置已保存。现在可以在网页中选中文字开始翻译。", "success");
  } catch (error) {
    showStatus(`保存失败：${error?.message || String(error)}`, "error");
  } finally {
    setBusy(false);
  }
});

testButton.addEventListener("click", async () => {
  if (activeConnectionCheck) {
    cancelConnectionCheck();
    return;
  }
  let config;
  let permissionPromise;
  try {
    config = validateSettings(formSettings());
    permissionPromise = requestEndpointPermission(config.endpoint);
  } catch (error) {
    showStatus(validationError(error), "error");
    return;
  }

  const check = { controller: new AbortController() };
  activeConnectionCheck = check;
  setBusy(true, "test");
  showStatus("正在检测连接，将发送一小段示例文字；可点击「取消检测」。", "working");
  try {
    if (!(await permissionPromise)) {
      if (activeConnectionCheck !== check) return;
      showStatus("未获得该服务的访问权限。请允许访问后重试。", "error");
      return;
    }
    if (activeConnectionCheck !== check) return;
    const { translation, durationMs } = await checkConnection({ settings: config, signal: check.controller.signal });
    if (activeConnectionCheck !== check) return;
    const sample = translation.length > 120 ? `${translation.slice(0, 120)}…` : translation;
    showStatus(`连接正常，已收到有效译文（${(durationMs / 1000).toFixed(1)} 秒）。示例译文：「${sample}」。检测本身不会保存配置。`, "success");
  } catch (error) {
    if (activeConnectionCheck !== check) return;
    const message = error?.message || String(error);
    showStatus(`连接检测失败：${message}`, "error");
  } finally {
    if (activeConnectionCheck === check) {
      activeConnectionCheck = null;
      setBusy(false);
    }
  }
});

async function initialize() {
  renderProviders();
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const stored = await chrome.storage.local.get("settings");
    const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    setProvider(settings.provider);
    endpointInput.value = settings.endpoint || "";
    apiKeyInput.value = settings.apiKey || "";
    modelInput.value = settings.model || "";
    targetInput.value = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;
    promptInput.value = settings.prompt || "";
  } catch (error) {
    showStatus(`无法读取设置：${error?.message || String(error)}`, "error");
  }
}

initialize();
