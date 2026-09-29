import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionDir = fileURLToPath(new URL('../', import.meta.url));
const chromiumExecutable = process.env.TRANSMATE_CHROMIUM_EXECUTABLE;

const requests = [];
let retryAttempts = 0;
let releaseSlowResponse;
let finishSlowResponse;
const slowResponseFinished = new Promise((resolve) => { finishSlowResponse = resolve; });
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
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
  };
  if (text === 'slow cancel') {
    await new Promise((resolve) => { releaseSlowResponse = resolve; });
  }
  if (!response.destroyed) {
    response.writeHead(200).end(JSON.stringify({
      choices: [{ message: { content: translations[text] || '默认译文' } }],
    }));
  }
  if (text === 'slow cancel') finishSlowResponse();
});

async function waitUntil(predicate, description, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时：' + description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const profileDir = await mkdtemp(join(tmpdir(), 'transmate-pr6-'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
let context;

try {
  const browserOptions = {
    headless: true,
    args: [
      '--disable-extensions-except=' + extensionDir,
      '--load-extension=' + extensionDir,
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

  console.log('PASS: 连接检测、模拟授权与保存、侧栏译文、取消旧结果、重试、双窗口选文');
  console.log('Mock POST requests: ' + requests.map((item) => item.text).join(', '));
} finally {
  releaseSlowResponse?.();
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profileDir, { recursive: true, force: true });
}
