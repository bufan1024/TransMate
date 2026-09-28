import { DEFAULT_SETTINGS, PROVIDERS, originPatternForEndpoint } from "./lib/config.js";
import { checkConnection } from "./lib/connection-check.js";
import { SettingsOperationError, canReuseSavedKey, persistSettings, resolveSettings, revokeGrantedOrigin, saveSettingsWithPermission, withSettingsLock } from "./lib/settings-management.js";

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
const keyStatus = document.querySelector("#key-status");
const clearKeyButton = document.querySelector("#clear-saved-key");
const resetButton = document.querySelector("#reset-settings");
const permissionList = document.querySelector("#permission-list");
let previousProvider = DEFAULT_SETTINGS.provider;
let activeConnectionCheck = null;
let savedSettings = null;
let operationBusy = false;
let permissionRefresh = 0;

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

function renderKeyStatus() {
  if (apiKeyInput.value.trim()) keyStatus.textContent = "将使用新填写的密钥；保存后才写入本机。";
  else if (canReuseSavedKey(formSettings(), savedSettings)) keyStatus.textContent = "此服务已有保存的密钥；留空即可沿用。";
  else if (savedSettings?.apiKey) keyStatus.textContent = "服务或接口已更改，请填写新的 API Key。";
  else keyStatus.textContent = "尚无已保存的密钥，请填写 API Key。";
  clearKeyButton.disabled = operationBusy || !savedSettings?.apiKey;
}

function fillForm(settings) {
  setProvider(settings.provider);
  endpointInput.value = settings.endpoint || "";
  apiKeyInput.value = "";
  modelInput.value = settings.model || "";
  targetInput.value = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;
  promptInput.value = settings.prompt || "";
  renderKeyStatus();
}

async function readSavedSettings() {
  const stored = await chrome.storage.local.get("settings");
  return stored.settings || null;
}

function renderPermissions(origins) {
  permissionList.replaceChildren();
  if (!origins.length) {
    const empty = document.createElement("li");
    empty.className = "permission-empty";
    empty.textContent = "当前没有已授权的服务域名。";
    permissionList.append(empty);
    return;
  }
  for (const origin of [...origins].sort()) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = origin;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "permission-revoke";
    button.textContent = "撤销";
    button.setAttribute("aria-label", `撤销 ${origin} 的访问权限`);
    button.disabled = operationBusy;
    button.addEventListener("click", () => revokeOrigin(origin));
    item.append(label, button);
    permissionList.append(item);
  }
}

async function refreshPermissions() {
  const refresh = ++permissionRefresh;
  try {
    const granted = await chrome.permissions.getAll();
    const origins = granted.origins || [];
    if (refresh === permissionRefresh) renderPermissions(origins);
    return origins;
  } catch {
    if (refresh === permissionRefresh) {
      permissionList.replaceChildren();
      const error = document.createElement("li");
      error.className = "permission-empty";
      error.textContent = "无法读取已授权域名，请重新打开设置页。";
      permissionList.append(error);
    }
    return null;
  }
}

async function revokeOrigin(origin) {
  if (operationBusy) return;
  cancelConnectionCheck();
  setBusy(true, "manage");
  try {
    const removed = await withSettingsLock(globalThis.navigator?.locks, () => revokeGrantedOrigin(origin, chrome.permissions));
    const origins = await refreshPermissions();
    if (origins === null) showStatus("无法确认撤销结果，请重新打开设置页检查授权列表。", "error");
    else if (origins.includes(origin)) showStatus(`撤销 ${origin} 失败，授权仍在。请重试或在 Chrome 扩展管理页处理。`, "error");
    else if (removed) showStatus(`已撤销 ${origin} 的访问权限。需要时可重新保存或测试连接。`, "success");
    else showStatus("该域名已没有授权，列表已刷新。", "working");
  } catch (error) {
    showSettingsFailure(error, "撤销失败，请检查浏览器权限并重试。");
    await refreshPermissions();
  } finally {
    setBusy(false);
  }
}

function showStatus(message, tone) {
  status.textContent = message;
  status.dataset.tone = tone;
  status.hidden = false;
}

function setBusy(busy, mode = "save") {
  operationBusy = busy;
  saveButton.disabled = busy;
  testButton.disabled = busy && mode !== "test";
  clearKeyButton.disabled = busy;
  resetButton.disabled = busy;
  for (const button of permissionList.querySelectorAll("button")) button.disabled = busy;
  for (const field of form.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
    field.disabled = busy && mode !== "test";
  }
  saveButton.querySelector("span:first-child").textContent = busy && mode === "save" ? "请稍候…" : "保存配置";
  testButton.querySelector(".test-label").textContent = busy && mode === "test" ? "取消检测" : busy ? "请稍候…" : "测试连接";
  testButton.dataset.testing = String(busy && mode === "test");
  renderKeyStatus();
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

function showSettingsFailure(error, fallback) {
  if (error instanceof SettingsOperationError) {
    showStatus(error.kind === "validation" ? validationError(error) : error.message, "error");
  } else {
    showStatus(fallback, "error");
  }
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
  apiKeyInput.value = "";
  previousProvider = event.target.value;
  renderKeyStatus();
  status.hidden = true;
});

endpointInput.addEventListener("input", () => {
  apiKeyInput.value = "";
  renderKeyStatus();
});

function onFormChanged() {
  renderKeyStatus();
  if (activeConnectionCheck) cancelConnectionCheck("配置已修改，连接检测已取消。请重新检测。");
  else status.hidden = true;
}
form.addEventListener("input", onFormChanged);
form.addEventListener("change", onFormChanged);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (operationBusy) return;
  if (typeof globalThis.navigator?.locks?.request !== "function") {
    showStatus("当前浏览器不支持安全的多页面设置操作，请升级 Chrome 后重试。", "error");
    return;
  }
  const draft = formSettings();
  let config;
  let permissionPromise;
  try {
    config = resolveSettings(draft, savedSettings);
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
    const result = await saveSettingsWithPermission({
      draft,
      storageArea: chrome.storage.local,
      permissionsApi: chrome.permissions,
      lockManager: globalThis.navigator?.locks,
    });
    savedSettings = result.settings;
    apiKeyInput.value = "";
    renderKeyStatus();
    showStatus(result.cleanupFailed
      ? "配置已保存，但旧域名权限未能撤销。请在下方授权列表中手动处理。"
      : "配置已保存。现在可以在网页中选中文字开始翻译。", result.cleanupFailed ? "error" : "success");
  } catch (error) {
    showSettingsFailure(error, "保存失败，请检查浏览器存储和权限后重试。新申请的域名权限可能仍保留在下方列表中。");
  } finally {
    await refreshPermissions();
    setBusy(false);
  }
});

testButton.addEventListener("click", async () => {
  if (activeConnectionCheck) {
    cancelConnectionCheck();
    return;
  }
  if (operationBusy) return;
  const draft = formSettings();
  let config;
  let permissionPromise;
  try {
    config = resolveSettings(draft, savedSettings);
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
    const current = await readSavedSettings();
    if (activeConnectionCheck !== check) return;
    config = resolveSettings(draft, current);
    const { translation, durationMs } = await checkConnection({ settings: config, signal: check.controller.signal });
    if (activeConnectionCheck !== check) return;
    const sample = translation.length > 120 ? `${translation.slice(0, 120)}…` : translation;
    showStatus(`连接正常，已收到有效译文（${(durationMs / 1000).toFixed(1)} 秒）。示例译文：「${sample}」。检测本身不会保存配置。`, "success");
  } catch (error) {
    if (activeConnectionCheck !== check) return;
    const message = error instanceof Error ? error.message : "请检查配置后重试。";
    showStatus(`连接检测失败：${message}`, "error");
  } finally {
    await refreshPermissions();
    if (activeConnectionCheck === check) {
      activeConnectionCheck = null;
      setBusy(false);
    }
  }
});

clearKeyButton.addEventListener("click", async () => {
  if (operationBusy) return;
  cancelConnectionCheck();
  setBusy(true, "manage");
  try {
    const outcome = await withSettingsLock(globalThis.navigator?.locks, async () => {
      const previous = await readSavedSettings();
      if (!previous?.apiKey) return { noKey: true, settings: previous };
      const next = { ...previous, apiKey: "" };
      const result = await persistSettings({ nextSettings: next, previousSettings: previous, storageArea: chrome.storage.local, permissionsApi: chrome.permissions });
      return { noKey: false, settings: next, ...result };
    });
    savedSettings = outcome.settings;
    if (outcome.noKey) {
      apiKeyInput.value = "";
      showStatus("当前没有已保存的 API Key。", "working");
      return;
    }
    apiKeyInput.value = "";
    showStatus(outcome.cleanupFailed
      ? "密钥已清除，但服务域名权限未能撤销。请在下方列表中手动处理。"
      : "已清除本机保存的密钥和当前输入。", outcome.cleanupFailed ? "error" : "success");
  } catch (error) {
    showSettingsFailure(error, "清除密钥失败，请检查浏览器存储后重试。");
  } finally {
    await refreshPermissions();
    setBusy(false);
  }
});

resetButton.addEventListener("click", async () => {
  if (operationBusy || !window.confirm("确定重置全部配置、清除密钥并撤销已授权域名吗？")) return;
  cancelConnectionCheck();
  setBusy(true, "manage");
  try {
    const result = await withSettingsLock(globalThis.navigator?.locks, async () => {
      const previous = await readSavedSettings();
      return persistSettings({ nextSettings: null, previousSettings: previous, storageArea: chrome.storage.local, permissionsApi: chrome.permissions });
    });
    savedSettings = null;
    fillForm(DEFAULT_SETTINGS);
    showStatus(result.cleanupFailed
      ? "配置已重置，但部分域名权限未能撤销。请在下方列表中手动处理。"
      : "本机配置和密钥已重置，已撤销授权域名。", result.cleanupFailed ? "error" : "success");
  } catch (error) {
    showSettingsFailure(error, "重置失败，原配置仍保留。请检查浏览器存储后重试。");
  } finally {
    await refreshPermissions();
    setBusy(false);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    savedSettings = changes.settings.newValue || null;
    renderKeyStatus();
  }
});

async function initialize() {
  renderProviders();
  fillForm(DEFAULT_SETTINGS);
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    savedSettings = await readSavedSettings();
    fillForm({ ...DEFAULT_SETTINGS, ...(savedSettings || {}) });
  } catch {
    showStatus("无法读取本机设置，请重新打开设置页。", "error");
  }
  await refreshPermissions();
}

initialize();
