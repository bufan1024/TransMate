import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionDir = fileURLToPath(new URL('../', import.meta.url));
const chromiumExecutable = process.env.TRANSMATE_CHROMIUM_EXECUTABLE;
const fixturePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>TransMate inline fixture</title>
<style>body { margin: 32px; font: 18px sans-serif; } p { margin: 20px 0; }</style>
<p id="inline-first">inline hello</p>
<p id="inline-slow">inline slow</p>
<p id="inline-latest">inline latest</p>
<p id="inline-close-slow">inline close slow</p>
<p id="shortcut-paragraph">shortcut paragraph</p>
<input id="shortcut-input" value="shortcut input">
<iframe id="shortcut-frame" src="/inline-frame" title="Shortcut frame"></iframe>
</html>`;
const frameFixturePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<p id="shortcut-frame-text">shortcut frame</p>
</html>`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const requests = [];
let retryAttempts = 0;
let releaseSlowResponse;
let finishSlowResponse;
const slowResponseFinished = new Promise((resolve) => { finishSlowResponse = resolve; });
const delayedInlineResponses = new Map([
  ['inline slow', { gate: deferred(), finished: deferred() }],
  ['inline close slow', { gate: deferred(), finished: deferred() }],
]);
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (request.method === 'GET' && request.url === '/inline-fixture') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.writeHead(200).end(fixturePage);
    return;
  }
  if (request.method === 'GET' && request.url === '/inline-frame') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.writeHead(200).end(frameFixturePage);
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const text = body.messages.find((message) => message.role === 'user')?.content;
  requests.push({ text, model: body.model });
  response.setHeader('Content-Type', 'application/json');

  if (text === 'retry me' && ++retryAttempts === 1) {
    response.writeHead(429).end(JSON.stringify({ error: 'sensitive upstream detail' }));
    return;
  }

  const translations = {
    'Hello, world.': '你好，世界。',
    'panel success': '侧栏译文',
    'slow cancel': '过期译文',
    'retry me': '重试成功',
    'window A selection': '窗口 A 译文',
    'window B selection': '窗口 B 译文',
    'inline hello': '页内译文',
    'inline slow': '过期页内译文',
    'inline latest': '最新页内译文',
    'inline close slow': '关闭后不应显示的译文',
    'shortcut paragraph': '快捷键段落译文',
    'shortcut input': '快捷键输入译文',
    'shortcut frame': '快捷键框架译文',
  };
  if (text === 'slow cancel') {
    await new Promise((resolve) => { releaseSlowResponse = resolve; });
  }
  const delayedInline = delayedInlineResponses.get(text);
  if (delayedInline) await delayedInline.gate.promise;
  if (!response.destroyed) {
    response.writeHead(200).end(JSON.stringify({
      choices: [{ message: { content: translations[text] || '默认译文' } }],
    }));
  }
  if (text === 'slow cancel') finishSlowResponse();
  delayedInline?.finished.resolve();
});

async function waitUntil(predicate, description, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时：' + description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function selectFixtureText(page, elementId) {
  return page.evaluate((id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error('缺少选文测试元素：' + id);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }, elementId);
}

async function triggerContextSelection(worker, tabId, text) {
  return worker.evaluate(async ({ tabId: selectedTabId, selectedText }) => {
    const backgroundRouter = globalThis.__transmateTestRouter;
    if (!backgroundRouter?.onClicked) throw new Error('背景事件路由未导出');
    const tab = await chrome.tabs.get(selectedTabId);
    backgroundRouter.onClicked({
      menuItemId: 'translate-selection',
      selectionText: selectedText,
    }, tab);
    return true;
  }, { tabId, selectedText: text });
}

async function triggerShortcutSelection(worker, tabId) {
  return worker.evaluate(async (selectedTabId) => {
    const backgroundRouter = globalThis.__transmateTestRouter;
    if (!backgroundRouter?.onCommand) throw new Error('背景快捷键路由未导出');
    const tab = await chrome.tabs.get(selectedTabId);
    backgroundRouter.onCommand('translate-selection', tab);
    return true;
  }, tabId);
}

const tempDir = await mkdtemp(join(tmpdir(), 'transmate-inline-'));
const profileDir = join(tempDir, 'profile');
const testExtensionDir = join(tempDir, 'extension');
const excludedExtensionDirs = new Set(['.git', '.codex', '.claude', '.agents', 'browser', 'node_modules', 'tests']);
await cp(extensionDir, testExtensionDir, {
  recursive: true,
  filter: (source) => !excludedExtensionDirs.has(relative(extensionDir, source).split(sep)[0]),
});
const testManifestPath = join(testExtensionDir, 'manifest.json');
const testManifest = JSON.parse(await readFile(testManifestPath, 'utf8'));
testManifest.host_permissions = [...new Set([
  ...(testManifest.host_permissions || []),
  'http://127.0.0.1/*',
])];
await writeFile(testManifestPath, JSON.stringify(testManifest));
// A service worker cannot import() a module from evaluate(). Expose the
// production router only in this throwaway extension copy for menu simulation.
const testBackgroundPath = join(testExtensionDir, 'background.js');
await writeFile(testBackgroundPath,
  `${await readFile(testBackgroundPath, 'utf8')}\n` +
  `globalThis.__transmateTestRouter = backgroundRouter;
globalThis.__transmateTestSidePanelOpens = 0;
const __transmateOriginalSidePanelOpen = chrome.sidePanel.open.bind(chrome.sidePanel);
chrome.sidePanel.open = (...args) => {
  globalThis.__transmateTestSidePanelOpens += 1;
  return __transmateOriginalSidePanelOpen(...args);
};
`);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
let context;

try {
  const browserOptions = {
    headless: true,
    args: [
      '--disable-extensions-except=' + testExtensionDir,
      '--load-extension=' + testExtensionDir,
    ],
  };
  if (chromiumExecutable) browserOptions.executablePath = chromiumExecutable;
  else browserOptions.channel = 'chromium';
  context = await chromium.launchPersistentContext(profileDir, browserOptions);

  // This fixture tests page behavior and requested origins. It deliberately
  // simulates Chrome's native optional-permission prompt, which Playwright
  // cannot confirm in a reproducible headless run.
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.permissions) return;
    globalThis.__permissionRequests = [];
    chrome.permissions.request = async (details) => {
      globalThis.__permissionRequests.push(details);
      return globalThis.__permissionGrant !== false;
    };
    chrome.permissions.contains = async () => globalThis.__permissionGrant !== false;
  });

  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto('chrome-extension://' + extensionId + '/options.html');
  await options.locator('input[name="provider"][value="custom"]').check();
  await options.locator('#endpoint').fill(endpoint);
  await options.locator('#api-key').fill('local-test-key');
  await options.locator('#model').fill('local-mock-model');

  await options.locator('#test-connection').click();
  await options.locator('#form-status[data-tone="success"]').waitFor();
  assert.match(await options.locator('#form-status').textContent(), /连接正常/);
  assert.equal(
    await options.evaluate(async () => (await chrome.storage.local.get('settings')).settings),
    undefined,
    '连接检测不得保存表单',
  );
  assert.deepEqual(
    await options.evaluate(() => globalThis.__permissionRequests[0].origins),
    ['http://127.0.0.1/*'],
  );
  assert.equal(requests[0].text, 'Hello, world.');
  assert.equal(requests[0].model, 'local-mock-model');

  await options.evaluate(() => { globalThis.__permissionGrant = false; });
  await options.locator('#save-settings').click();
  await options.locator('#form-status[data-tone="error"]').waitFor();
  assert.match(await options.locator('#form-status').textContent(), /未获得该服务的访问权限/);
  assert.equal(
    await options.evaluate(async () => (await chrome.storage.local.get('settings')).settings),
    undefined,
    '拒绝授权时不得保存配置',
  );
  await options.evaluate(() => { globalThis.__permissionGrant = true; });

  await options.locator('#save-settings').click();
  await options.locator('#form-status[data-tone="success"]').waitFor();
  assert.match(await options.locator('#form-status').textContent(), /配置已保存/);
  const saved = await options.evaluate(async () =>
    (await chrome.storage.local.get('settings')).settings);
  assert.equal(saved.endpoint, endpoint);
  assert.equal(saved.model, 'local-mock-model');
  assert.deepEqual(await options.evaluate(() => globalThis.__permissionRequests.map((item) => item.origins)), [
    ['http://127.0.0.1/*'],
    ['http://127.0.0.1/*'],
    ['http://127.0.0.1/*'],
  ]);

  const panel = await context.newPage();
  const panelUrl = 'chrome-extension://' + extensionId + '/sidepanel.html';
  await panel.goto(panelUrl);
  await panel.locator('#source-text').fill('panel success');
  await panel.locator('#translate-button').click();
  await panel.locator('#result-text').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#result-text').textContent(), '侧栏译文');

  await panel.locator('#source-text').fill('slow cancel');
  await panel.locator('#translate-button').click();
  await waitUntil(
    () => requests.some((item) => item.text === 'slow cancel'),
    '延迟请求已发出',
  );
  await panel.locator('#source-text').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    requests.filter((item) => item.text === 'slow cancel').length,
    1,
    '翻译进行中按快捷键不得重复发送请求',
  );
  await panel.locator('#source-text').fill('replacement');
  releaseSlowResponse();
  await slowResponseFinished;
  await panel.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await panel.locator('#result-text').isVisible(), false);
  assert.equal(await panel.locator('#copy-button').isDisabled(), true);
  assert.equal(await panel.locator('#result-state').textContent(), '等待输入');

  await panel.locator('#source-text').fill('retry me');
  await panel.locator('#translate-button').click();
  await panel.locator('#result-error').waitFor({ state: 'visible' });
  assert.match(await panel.locator('#error-message').textContent(), /HTTP 429/);
  assert.doesNotMatch(await panel.locator('#error-message').textContent(), /sensitive upstream detail/);
  assert.equal(retryAttempts, 1);
  await panel.locator('#retry-button').click();
  await panel.locator('#result-text').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#result-text').textContent(), '重试成功');
  assert.equal(retryAttempts, 2);

  const firstWindowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const [secondPanel] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }),
    options.evaluate((url) => chrome.windows.create({ url, focused: false }), panelUrl),
  ]);
  await secondPanel.waitForLoadState();
  const secondWindowId = await secondPanel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  assert.notEqual(firstWindowId, secondWindowId, '必须使用两个真实 Chrome 窗口');

  const createdAt = Date.now();
  const firstSelection = {
    id: 'browser-window-a', text: 'window A selection', createdAt,
    order: createdAt * 1000 + 1, windowId: firstWindowId,
  };
  const secondSelection = {
    id: 'browser-window-b', text: 'window B selection', createdAt,
    order: createdAt * 1000 + 2, windowId: secondWindowId,
  };
  const firstKey = 'pendingSelection:' + firstWindowId + ':' + firstSelection.id;
  const secondKey = 'pendingSelection:' + secondWindowId + ':' + secondSelection.id;
  await options.evaluate(async (data) => {
    await chrome.storage.session.set({ [data.firstKey]: data.firstSelection });
    await chrome.storage.session.set({ [data.secondKey]: data.secondSelection });
  }, { firstKey, secondKey, firstSelection, secondSelection });

  await Promise.all([
    waitUntil(async () =>
      await panel.locator('#result-text').isVisible()
      && await panel.locator('#result-text').textContent() === '窗口 A 译文',
    '窗口 A 收到自己的译文'),
    waitUntil(async () =>
      await secondPanel.locator('#result-text').isVisible()
      && await secondPanel.locator('#result-text').textContent() === '窗口 B 译文',
    '窗口 B 收到自己的译文'),
  ]);
  assert.equal(await panel.locator('#source-text').inputValue(), 'window A selection');
  assert.equal(await panel.locator('#result-text').textContent(), '窗口 A 译文');
  assert.equal(await secondPanel.locator('#source-text').inputValue(), 'window B selection');
  assert.equal(await secondPanel.locator('#result-text').textContent(), '窗口 B 译文');
  await waitUntil(async () => {
    const remaining = await options.evaluate((keys) => chrome.storage.session.get(keys), [firstKey, secondKey]);
    return Object.keys(remaining).length === 0;
  }, '两个窗口的选文事件已各自消费');
  assert.equal(requests.filter((item) => item.text === 'window A selection').length, 1);
  assert.equal(requests.filter((item) => item.text === 'window B selection').length, 1);

  // The test extension alone has localhost page access, so the real background
  // route can inject its content script without automating Chrome's native menu.
  const inlineUrl = new URL('/inline-fixture', endpoint).href;
  const inlinePage = await context.newPage();
  await inlinePage.goto(inlineUrl);
  const inlineTabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, inlineUrl);
  assert.ok(Number.isInteger(inlineTabId), '必须找到本地网页标签页');
  const inlineHost = inlinePage.locator('#transmate-inline-host');
  const initialPageCount = context.pages().length;

  let selectedText = await selectFixtureText(inlinePage, 'inline-first');
  assert.equal(selectedText, 'inline hello');
  await triggerContextSelection(worker, inlineTabId, selectedText);
  await inlineHost.locator('.result').waitFor({ state: 'visible' });
  assert.equal(await inlineHost.locator('.source').textContent(), selectedText);
  assert.equal(await inlineHost.locator('.result').textContent(), '页内译文');
  assert.equal(requests.filter((item) => item.text === selectedText).length, 1);
  assert.equal(inlinePage.url(), inlineUrl, '页内翻译不得跳转当前网页');
  assert.equal(context.pages().length, initialPageCount, '页内翻译不得新建窗口或标签页');
  const bounds = await inlineHost.boundingBox();
  const viewport = inlinePage.viewportSize();
  assert.ok(bounds && viewport && bounds.x >= 0 && bounds.y >= 0
    && bounds.x + bounds.width <= viewport.width
    && bounds.y + bounds.height <= viewport.height,
  '浮层应保持在可见区域内');

  await inlinePage.evaluate(() => {
    const shadow = document.querySelector('#transmate-inline-host').shadowRoot;
    [...shadow.querySelectorAll('button')].find((button) => button.textContent === '重试').click();
    [...shadow.querySelectorAll('button')].find((button) => button.textContent === '设置').click();
  });
  await inlinePage.waitForTimeout(150);
  assert.equal(requests.filter((item) => item.text === 'inline hello').length, 1,
    '网页脚本合成点击不得触发额外付费请求');
  assert.equal(context.pages().length, initialPageCount,
    '网页脚本合成点击不得打开设置页');

  // Simulate MV3 worker memory loss: retry must recover the selection from
  // extension session storage rather than relying on a module global.
  await worker.evaluate(() => globalThis.__transmateTestRouter.activeByTab.clear());
  await inlineHost.getByRole('button', { name: '重试' }).click();
  await waitUntil(() => requests.filter((item) => item.text === 'inline hello').length === 2,
    '后台恢复选文并重试');
  await waitUntil(async () => await inlineHost.locator('.result').isVisible()
    && await inlineHost.locator('.result').textContent() === '页内译文', '浮层重试译文');

  await worker.evaluate(() => globalThis.__transmateTestRouter.activeByTab.clear());
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, prompt: 'Changed during inline display' } });
  });
  await inlineHost.locator('.error').waitFor({ state: 'visible' });
  assert.match(await inlineHost.locator('.error').textContent(), /配置已更新/);

  await inlineHost.getByRole('button', { name: '关闭翻译' }).click();
  await inlineHost.waitFor({ state: 'detached' });

  selectedText = await selectFixtureText(inlinePage, 'inline-slow');
  await triggerContextSelection(worker, inlineTabId, selectedText);
  await inlineHost.locator('.loading').waitFor({ state: 'visible' });
  await waitUntil(() => requests.some((item) => item.text === 'inline slow'), '延迟页内请求已发出');
  selectedText = await selectFixtureText(inlinePage, 'inline-latest');
  await triggerContextSelection(worker, inlineTabId, selectedText);
  await waitUntil(async () =>
    await inlineHost.locator('.result').isVisible()
    && await inlineHost.locator('.result').textContent() === '最新页内译文',
  '新选文替换旧请求');
  assert.equal(await inlineHost.count(), 1, '重复划词只应保留一个浮层');
  delayedInlineResponses.get('inline slow').gate.resolve();
  await delayedInlineResponses.get('inline slow').finished.promise;
  await inlinePage.waitForTimeout(150);
  assert.equal(await inlineHost.locator('.source').textContent(), 'inline latest');
  assert.equal(await inlineHost.locator('.result').textContent(), '最新页内译文',
    '迟到的旧译文不得覆盖新选文');
  assert.equal(requests.filter((item) => item.text === 'inline latest').length, 1);

  await inlinePage.keyboard.press('Escape');
  await inlineHost.waitFor({ state: 'detached' });
  selectedText = await selectFixtureText(inlinePage, 'inline-close-slow');
  await triggerContextSelection(worker, inlineTabId, selectedText);
  await waitUntil(() => requests.some((item) => item.text === 'inline close slow'), '关闭前的页内请求已发出');
  await inlineHost.getByRole('button', { name: '关闭翻译' }).click();
  await inlineHost.waitFor({ state: 'detached' });
  delayedInlineResponses.get('inline close slow').gate.resolve();
  await delayedInlineResponses.get('inline close slow').finished.promise;
  await inlinePage.waitForTimeout(150);
  assert.equal(await inlineHost.count(), 0, '关闭后迟到的译文不得重新打开浮层');
  assert.equal(context.pages().length, initialPageCount, '页内流程不得新建窗口或标签页');
  assert.equal(await worker.evaluate(() => globalThis.__transmateTestSidePanelOpens), 0,
    '普通网页的页内翻译不得打开侧栏');

  // The browser reserves native extension shortcuts, so invoke the registered
  // route directly while its selection reader and UI run in real page frames.
  const shortcutCommand = await worker.evaluate(async () =>
    (await chrome.commands.getAll()).find((command) => command.name === 'translate-selection'));
  assert.ok(shortcutCommand, 'manifest 必须注册划词翻译快捷键');
  assert.match(shortcutCommand.shortcut,
    process.platform === 'darwin' ? /^(?:⌥|Option\+|Alt\+)1$/ : /^Ctrl\+Shift\+Y$/,
    'Chrome 必须实际分配当前平台的默认快捷键');
  await inlinePage.bringToFront();
  selectedText = await selectFixtureText(inlinePage, 'shortcut-paragraph');
  await triggerShortcutSelection(worker, inlineTabId);
  await waitUntil(async () => await inlineHost.locator('.result').isVisible()
    && await inlineHost.locator('.result').textContent() === '快捷键段落译文',
  '快捷键翻译普通段落');
  assert.equal(await inlineHost.locator('.source').textContent(), selectedText);
  assert.equal(requests.filter((item) => item.text === 'shortcut paragraph').length, 1);
  await inlineHost.getByRole('button', { name: '关闭翻译' }).click();
  await inlineHost.waitFor({ state: 'detached' });

  selectedText = await inlinePage.locator('#shortcut-input').evaluate((input) => {
    window.getSelection()?.removeAllRanges();
    input.focus();
    input.setSelectionRange(0, input.value.length);
    return input.value.slice(input.selectionStart, input.selectionEnd);
  });
  assert.equal(selectedText, 'shortcut input');
  await triggerShortcutSelection(worker, inlineTabId);
  await waitUntil(async () => await inlineHost.locator('.result').isVisible()
    && await inlineHost.locator('.result').textContent() === '快捷键输入译文',
  '快捷键翻译输入框选文');
  assert.equal(await inlineHost.locator('.source').textContent(), selectedText);
  assert.equal(requests.filter((item) => item.text === 'shortcut input').length, 1);
  await inlineHost.getByRole('button', { name: '关闭翻译' }).click();
  await inlineHost.waitFor({ state: 'detached' });

  await inlinePage.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.activeElement?.blur?.();
  });
  const shortcutFrameText = inlinePage.frameLocator('#shortcut-frame').locator('#shortcut-frame-text');
  await shortcutFrameText.click();
  selectedText = await shortcutFrameText.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    return window.getSelection()?.toString();
  });
  assert.equal(selectedText, 'shortcut frame');
  await triggerShortcutSelection(worker, inlineTabId);
  await waitUntil(async () => await inlinePage.frameLocator('#shortcut-frame')
    .locator('#transmate-inline-host .result').isVisible()
    && await inlinePage.frameLocator('#shortcut-frame')
      .locator('#transmate-inline-host .result').textContent() === '快捷键框架译文',
  '快捷键翻译同源框架选文');
  const frameHost = inlinePage.frameLocator('#shortcut-frame').locator('#transmate-inline-host');
  assert.equal(await frameHost.locator('.source').textContent(), selectedText);
  assert.equal(requests.filter((item) => item.text === 'shortcut frame').length, 1);
  await frameHost.getByRole('button', { name: '关闭翻译' }).click();
  await frameHost.waitFor({ state: 'detached' });

  await inlinePage.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    const input = document.querySelector('#shortcut-input');
    input.setSelectionRange(0, 0);
    input.blur();
  });
  await shortcutFrameText.evaluate(() => window.getSelection()?.removeAllRanges());
  await inlinePage.locator('body').click({ position: { x: 4, y: 4 } });
  const beforeEmptyShortcut = requests.length;
  await triggerShortcutSelection(worker, inlineTabId);
  await inlineHost.getByText(/请先选中文字/).waitFor({ state: 'visible' });
  assert.equal(requests.length, beforeEmptyShortcut, '空选文快捷键不得调用 AI 服务');
  assert.equal(context.pages().length, initialPageCount, '快捷键翻译不得新建窗口或标签页');

  console.log('PASS: 连接检测、模拟授权与保存、侧栏译文、取消旧结果、重试、双窗口选文、页内划词浮层、快捷键翻译');
  console.log('Mock POST requests: ' + requests.map((item) => item.text).join(', '));
} finally {
  releaseSlowResponse?.();
  for (const delayed of delayedInlineResponses.values()) delayed.gate.resolve();
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}
