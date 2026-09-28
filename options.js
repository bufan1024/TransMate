import { DEFAULT_SETTINGS, PROVIDERS, originPatternForEndpoint, validateSettings } from "./lib/config.js";
import { translate } from "./lib/translator.js";

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

function setBusy(busy) {
  saveButton.disabled = busy;
  testButton.disabled = busy;
  saveButton.querySelector("span:first-child").textContent = busy ? "请稍候…" : "保存配置";
  testButton.querySelector(".test-label").textContent = busy ? "测试中…" : "测试连接";
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
  showStatus("正在发送一小段示例文字…", "working");
  try {
    if (!(await permissionPromise)) {
      showStatus("未获得该服务的访问权限。请允许访问后重试。", "error");
      return;
    }
    const result = await translate({ text: "Hello, world.", settings: config });
    showStatus(`连接成功。示例译文：${result}`, "success");
  } catch (error) {
    const message = error?.message || String(error);
    showStatus(`连接失败：${message}`, "error");
  } finally {
    setBusy(false);
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
