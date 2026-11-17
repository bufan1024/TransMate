import { DEFAULT_AUTH_TYPE, DEFAULT_SETTINGS, PROVIDERS, originPatternForEndpoint } from "./lib/config.js";
import { checkConnection } from "./lib/connection-check.js";
import {
  DEFAULT_PROFILE_NAME, SERVICE_PROFILES_KEY, SettingsOperationError, activateServiceProfile,
  canReuseSavedKey, clearServiceProfileKey, deleteServiceProfile, profileOrigin,
  readServiceProfiles, resetServiceProfiles, resolveSettings, revokeGrantedOrigin, saveSettingsWithPermission, withSettingsLock,
} from "./lib/settings-management.js";

const form = document.querySelector("#settings-form");
const profileSelect = document.querySelector("#service-profile");
const profileName = document.querySelector("#profile-name");
const newProfileButton = document.querySelector("#new-profile");
const activateProfileButton = document.querySelector("#activate-profile");
const deleteProfileButton = document.querySelector("#delete-profile");
const providerList = document.querySelector("#provider-list");
const endpointInput = document.querySelector("#endpoint");
const endpointHelp = document.querySelector("#endpoint-help");
const customAuthentication = document.querySelector("#custom-authentication");
const authTypeInput = document.querySelector("#auth-type");
const claudeWorkspace = document.querySelector("#claude-workspace");
const workspaceIdInput = document.querySelector("#workspace-id");
const apiKeyField = document.querySelector("#api-key-field");
const apiKeyInput = document.querySelector("#api-key");
const modelInput = document.querySelector("#model");
const targetInput = document.querySelector("#target-language");
const promptInput = document.querySelector("#prompt");
const status = document.querySelector("#form-status");
const statusMessage = document.querySelector("#form-status-message");
const saveTestedButton = document.querySelector("#save-tested-settings");
const saveButton = document.querySelector("#save-settings");
const testButton = document.querySelector("#test-connection");
const keyStatus = document.querySelector("#key-status");
const clearKeyButton = document.querySelector("#clear-saved-key");
const resetButton = document.querySelector("#reset-settings");
const permissionList = document.querySelector("#permission-list");
let previousProvider = DEFAULT_SETTINGS.provider;
let activeConnectionCheck = null;
let savedSettings = null;
let serviceProfiles = { activeId: null, profiles: [] };
let editedProfileId = null;
let profileRevision = 0;
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
  const provider = selectedProvider();
  const authType = provider === "custom" ? authTypeInput.value : DEFAULT_AUTH_TYPE;
  return {
    provider,
    endpoint: endpointInput.value.trim(),
    authType,
    ...(provider === "anthropic" ? { workspaceId: workspaceIdInput.value.trim() } : {}),
    apiKey: authType === "none" ? "" : apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    targetLanguage: targetInput.value,
    prompt: promptInput.value.trim(),
  };
}

function renderKeyStatus() {
  const draft = formSettings();
  customAuthentication.hidden = draft.provider !== "custom";
  const claude = draft.provider === "anthropic";
  claudeWorkspace.hidden = !claude;
  apiKeyField.hidden = draft.authType === "none";
  endpointInput.placeholder = providerById(draft.provider)?.endpoint || "https://example.com/v1/chat/completions";
  if (claude) endpointHelp.textContent = "填写以 /v1/messages 结尾的 Claude Messages 接口地址。";
  else if (draft.provider === "gemini") endpointHelp.textContent = "填写 Gemini API 基础地址，以 /v1beta 或 /v1 结尾。模型 ID 在下方填写。";
  else if (draft.provider === "custom") endpointHelp.textContent = "填写服务的完整 Chat Completions 请求地址。自定义接口可使用不同路径。";
  else endpointHelp.textContent = "填写完整的 Chat Completions 接口地址。仅本机服务可使用 HTTP。";
  if (draft.apiKey) keyStatus.textContent = "将使用新填写的密钥；保存后才写入本机。";
  else if (canReuseSavedKey(draft, savedSettings)) keyStatus.textContent = "此服务已有保存的密钥；留空即可沿用。";
  else if (savedSettings?.apiKey) keyStatus.textContent = "服务、接口或认证方式已更改，请填写新的 API Key。";
  else keyStatus.textContent = "尚无已保存的密钥，请填写 API Key。";
  clearKeyButton.disabled = operationBusy || !savedSettings?.apiKey;
}

function fillForm(settings) {
  setProvider(settings.provider);
  endpointInput.value = settings.endpoint || "";
  authTypeInput.value = settings.provider === "custom" ? settings.authType ?? DEFAULT_AUTH_TYPE : DEFAULT_AUTH_TYPE;
  workspaceIdInput.value = settings.provider === "anthropic" ? settings.workspaceId ?? "" : "";
  apiKeyInput.value = "";
  modelInput.value = settings.model || "";
  targetInput.value = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;
  promptInput.value = settings.prompt || "";
  renderKeyStatus();
}

function settingsEnvironment() {
  return {
    storageArea: chrome.storage.local, permissionsApi: chrome.permissions, lockManager: globalThis.navigator?.locks,
  };
}

function editedProfile() {
  return serviceProfiles.profiles.find(({ id }) => id === editedProfileId);
}

function renderProfileControls() {
  const profile = editedProfile();
  newProfileButton.disabled = operationBusy && !activeConnectionCheck;
  deleteProfileButton.disabled = operationBusy || !profile;
  activateProfileButton.disabled = operationBusy || !profile || profile.id === serviceProfiles.activeId || !profileOrigin(profile);
}

function renderProfiles() {
  const options = serviceProfiles.profiles.map(({ id, name }) =>
    new Option(id === serviceProfiles.activeId ? `${name}（当前）` : name, id));
  profileSelect.replaceChildren(new Option("新配置", ""), ...options);
  profileSelect.value = editedProfileId ?? "";
  renderProfileControls();
}

function editProfile(id) {
  editedProfileId = id;
  const profile = editedProfile();
  savedSettings = profile?.settings ?? null;
  profileName.value = profile?.name ?? (serviceProfiles.profiles.length ? "" : DEFAULT_PROFILE_NAME);
  fillForm({ ...DEFAULT_SETTINGS, ...savedSettings });
  renderProfiles();
}

function applyProfiles(state, selectedId) {
  profileRevision += 1;
  serviceProfiles = state;
  if (selectedId !== undefined) {
    editProfile(selectedId);
  } else if (editedProfileId !== null && !editedProfile()) {
    editProfile(state.activeId);
  } else {
    savedSettings = editedProfile()?.settings ?? null;
    renderProfiles();
    renderKeyStatus();
  }
}

async function readSavedProfile(id) {
  const state = await readServiceProfiles(chrome.storage.local);
  return state.profiles.find((profile) => profile.id === id);
}

function renderPermissions(origins) {
  permissionList.replaceChildren();
  if (!origins.length) {
    const empty = document.createElement("li");
    empty.className = "permission-empty";
    empty.textContent = "当前没有已授权的域名。";
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

function showStatus(message, tone, { connectionResult = false, offerSave = false } = {}) {
  statusMessage.textContent = message;
  status.dataset.tone = tone;
  status.dataset.connectionResult = String(connectionResult);
  saveTestedButton.hidden = !offerSave;
  status.hidden = false;
}

function matchesConfig(config, candidate) {
  return Boolean(candidate && (config.authType ?? DEFAULT_AUTH_TYPE) === (candidate.authType ?? DEFAULT_AUTH_TYPE)
    && (config.workspaceId ?? "") === (candidate.workspaceId ?? "")
    && Object.entries(config).every(([key, value]) => key === "authType" || candidate[key] === value));
}

function setBusy(busy, mode = "save") {
  operationBusy = busy;
  saveButton.disabled = busy;
  saveTestedButton.disabled = busy;
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
  renderProfileControls();
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
  if (/配置名称/.test(message)) profileName.focus();
  else if (/认证方式/.test(message) && !customAuthentication.hidden) authTypeInput.focus();
  else if (/工作区 ID/.test(message) && !claudeWorkspace.hidden) workspaceIdInput.focus();
  else if (/invalid url|endpoint|https|接口/i.test(message)) endpointInput.focus();
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

function requestEndpointPermission({ endpoint, provider }) {
  // Call within the click/submit gesture, before any await.
  return chrome.permissions.request({ origins: [originPatternForEndpoint(endpoint, provider)] });
}

function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === id);
}

profileSelect.addEventListener("change", () => {
  if (operationBusy && !activeConnectionCheck) return;
  cancelConnectionCheck();
  editProfile(profileSelect.value || null);
  status.hidden = true;
});

newProfileButton.addEventListener("click", () => {
  if (operationBusy && !activeConnectionCheck) return;
  cancelConnectionCheck();
  editProfile(null);
  status.hidden = true;
  profileName.focus();
});

activateProfileButton.addEventListener("click", async () => {
  const profile = editedProfile();
  const origin = profileOrigin(profile);
  if (operationBusy || !origin || profile.id === serviceProfiles.activeId) return;
  setBusy(true, "manage");
  showStatus("正在切换当前 AI 配置…", "working");
  try {
    if (!await chrome.permissions.request({ origins: [origin] })) {
      showStatus("未获得该服务的访问权限。配置未切换。", "error");
      return;
    }
    const { state } = await activateServiceProfile({
      profileId: profile.id, expectedOrigin: origin, ...settingsEnvironment(),
    });
    applyProfiles(state);
    showStatus("已切换当前 AI 配置。", "success");
  } catch (error) {
    showSettingsFailure(error, "切换配置失败，请检查浏览器存储和权限后重试。");
  } finally {
    await refreshPermissions();
    setBusy(false);
  }
});

deleteProfileButton.addEventListener("click", async () => {
  const profile = editedProfile();
  if (operationBusy || !profile || !window.confirm(`确定删除配置「${profile.name}」和它的密钥吗？`)) return;
  setBusy(true, "manage");
  try {
    const { state, cleanupFailed } = await deleteServiceProfile({ profileId: profile.id, ...settingsEnvironment() });
    applyProfiles(state, state.activeId);
    showStatus(cleanupFailed ? "配置已删除，但部分域名权限未能撤销。" : "配置已删除。", cleanupFailed ? "error" : "success");
  } catch (error) {
    showSettingsFailure(error, "删除配置失败，请检查浏览器存储后重试。");
  } finally {
    await refreshPermissions();
    setBusy(false);
  }
});

providerList.addEventListener("change", (event) => {
  if (event.target.name !== "provider") return;
  const oldPreset = providerById(previousProvider);
  const nextPreset = providerById(event.target.value);
  const endpoint = endpointInput.value.trim();
  if (!endpoint || endpoint === oldPreset?.endpoint || oldPreset?.protocol !== nextPreset?.protocol) {
    endpointInput.value = nextPreset?.endpoint || "";
  }
  authTypeInput.value = DEFAULT_AUTH_TYPE;
  workspaceIdInput.value = "";
  apiKeyInput.value = "";
  previousProvider = event.target.value;
  renderKeyStatus();
  status.hidden = true;
});

endpointInput.addEventListener("input", () => {
  apiKeyInput.value = "";
  renderKeyStatus();
});
authTypeInput.addEventListener("change", () => {
  apiKeyInput.value = "";
});

function onFormChanged(event) {
  if (event.target === profileSelect) return;
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
  const name = profileName.value.trim();
  const profileId = editedProfileId;
  let config;
  let permissionPromise;
  try {
    if (!name || name.length > 48) throw new Error("请输入 1 到 48 个字符的配置名称。");
    config = resolveSettings(draft, savedSettings);
    permissionPromise = requestEndpointPermission(config);
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
      draft, name, profileId, ...settingsEnvironment(),
    });
    applyProfiles(result.state, result.profile.id);
    showStatus(result.cleanupFailed
      ? "配置已保存，但旧域名权限未能撤销。请在下方授权列表中手动处理。"
      : "配置已保存。", result.cleanupFailed ? "error" : "success");
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
  const profileId = editedProfileId;
  const name = profileName.value.trim();
  let config;
  let permissionPromise;
  try {
    config = resolveSettings(draft, savedSettings);
    permissionPromise = requestEndpointPermission(config);
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
    const current = await readSavedProfile(profileId);
    if (activeConnectionCheck !== check) return;
    if (profileId && !current) {
      showStatus("这套配置已被删除，请重新选择或新建配置。", "working");
      return;
    }
    config = resolveSettings(draft, current?.settings);
    const { translation, durationMs } = await checkConnection({ settings: config, signal: check.controller.signal });
    if (activeConnectionCheck !== check) return;
    const latestSaved = await readSavedProfile(profileId);
    if (activeConnectionCheck !== check) return;
    let latestDraft;
    try {
      latestDraft = resolveSettings(draft, latestSaved?.settings);
    } catch {
      // The draft may have depended on a saved key that changed during the check.
    }
    if ((profileId && !latestSaved) || !matchesConfig(config, latestDraft)) {
      showStatus("已收到示例译文，但本机配置在检测期间发生变化，请重新检测。", "working");
      return;
    }
    const alreadySaved = latestSaved?.name === name && matchesConfig(config, latestSaved.settings);
    const sample = translation.length > 120 ? `${translation.slice(0, 120)}…` : translation;
    const resultMessage = `连接正常，已收到有效译文（${(durationMs / 1000).toFixed(1)} 秒）。示例译文：「${sample}」。`;
    showStatus(resultMessage + (alreadySaved ? "当前配置已保存。" : "当前草稿尚未保存。"), "success", {
      connectionResult: true, offerSave: !alreadySaved,
    });
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
  if (operationBusy || !editedProfileId) return;
  cancelConnectionCheck();
  setBusy(true, "manage");
  try {
    const outcome = await clearServiceProfileKey({ profileId: editedProfileId, ...settingsEnvironment() });
    applyProfiles(outcome.state);
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
  if (operationBusy || !window.confirm("确定重置 AI 服务配置、清除密钥并撤销不再使用的域名授权吗？")) return;
  cancelConnectionCheck();
  setBusy(true, "manage");
  try {
    const result = await resetServiceProfiles(settingsEnvironment());
    applyProfiles({ activeId: null, profiles: [] }, null);
    showStatus(result.cleanupFailed
      ? "配置已重置，但部分域名权限未能撤销。请在下方列表中手动处理。"
      : "AI 服务配置和密钥已重置，已撤销不再使用的域名授权。", result.cleanupFailed ? "error" : "success");
  } catch (error) {
    showSettingsFailure(error, "重置失败，原配置仍保留。请检查浏览器存储后重试。");
  } finally {
    await refreshPermissions();
    setBusy(false);
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || (!changes.settings && !changes[SERVICE_PROFILES_KEY])) return;
  const revision = ++profileRevision;
  try {
    const state = await readServiceProfiles(chrome.storage.local);
    if (revision !== profileRevision) return;
    const old = editedProfile();
    const next = state.profiles.find(({ id }) => id === editedProfileId);
    const editedChanged = Boolean(old && (old.name !== next?.name || !matchesConfig(old.settings, next?.settings)));
    applyProfiles(state);
    if (editedChanged && activeConnectionCheck) {
      cancelConnectionCheck("本机配置已更新，请重新检测当前表单。");
    } else if (editedChanged && !status.hidden && status.dataset.connectionResult === "true") {
      showStatus("本机配置已更新，请重新检测当前表单。", "working");
    }
  } catch {
    if (revision === profileRevision) showStatus("无法读取本机设置，请重新打开设置页。", "error");
  }
});

async function initialize() {
  renderProviders();
  editProfile(null);
  setBusy(true, "manage");
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const revision = profileRevision;
    const state = await readServiceProfiles(chrome.storage.local);
    if (revision === profileRevision) applyProfiles(state, state.activeId);
  } catch {
    showStatus("无法读取本机设置，请重新打开设置页。", "error");
  } finally {
    await refreshPermissions();
    setBusy(false);
  }
}

chrome.permissions.onAdded?.addListener(() => { void refreshPermissions(); });
chrome.permissions.onRemoved?.addListener(() => { void refreshPermissions(); });

initialize();
