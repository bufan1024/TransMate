import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionDir = fileURLToPath(new URL('../', import.meta.url));
const chromiumExecutable = process.env.TRANSMATE_CHROMIUM_EXECUTABLE;
const longInlineSource = 'The river carried small branches and leaves past the quiet town after the rain. '.repeat(20).trim();
const fixturePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>TransMate inline fixture</title>
<style>
  body { margin: 32px; min-height: 140vh; font: 18px sans-serif; }
  p { margin: 20px 0; }
  #inline-first { margin-top: 130px; }
  #inline-long { font-size: 12px; }
</style>
<button id="fixture-control">Page control</button>
<p id="inline-first">inline hello</p>
<p id="inline-slow">inline slow</p>
<p id="inline-latest">inline latest</p>
<p id="inline-close-slow">inline close slow</p>
<p id="inline-switch-language">inline switch language</p>
<p id="inline-stream-text">inline stream text</p>
<p id="shortcut-paragraph">shortcut paragraph</p>
<input id="shortcut-input" value="shortcut input">
<iframe id="shortcut-frame" src="/inline-frame" title="Shortcut frame"></iframe>
<p id="inline-long">${longInlineSource}</p>
</html>`;
const frameFixturePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<p id="shortcut-frame-text">shortcut frame</p>
</html>`;
const articleFixturePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Reading the night sky</title>
<nav>navigation omitted</nav>
<main>
  <article>
    <h1>Reading the night sky</h1>
    <p id="article-intro">Look for the <a href="#article-tip">north star</a> after dusk.</p>
    <p id="article-tip">Let your eyes adjust to the dark.</p>
    <ul><li>Bring a red flashlight.</li></ul>
    <nav>article navigation omitted</nav>
    <p hidden>hidden page text omitted</p>
    <p style="visibility:hidden">invisible page text omitted</p>
    <form><label>form label omitted <input value="form value omitted"></label></form>
    <div contenteditable="true">editable page text omitted</div>
  </article>
</main>
<footer>site footer omitted</footer>
</html>`;
const articleBlocks = [
  'Reading the night sky',
  'Look for the north star after dusk.',
  'Let your eyes adjust to the dark.',
  'Bring a red flashlight.',
];
const articleTranslations = [
  '阅读夜空',
  '黄昏后寻找北极星。',
  '让眼睛适应黑暗。',
  '带上<em id="unexpected-page-markup">红光手电筒</em>。',
];
const articleSummary = '寻找北极星前，先让眼睛适应黑暗。准备一支红光手电筒。';
const viewportBlocks = [
  ['viewport-intro', 'Viewport introduction to shoreline tides.', '视口内的潮汐介绍。'],
  ['viewport-next', 'Viewport detail about estuary currents.', '视口内的河口潮流。'],
  ['viewport-prefetch', 'Nearby forecast about tomorrow tides.', '附近的明日潮汐预报。'],
  ['viewport-after-scroll', 'Middle section about a coastal station.', '页面中段的沿海观测站。'],
  ['viewport-distant', 'Distant appendix about measurements.', '远处的测量附录。'],
];
const viewportTranslations = new Map(viewportBlocks.map(([, text, translation]) => [text, translation]));
const viewportFixturePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Shoreline tides</title>
<style>
  body { margin: 0; }
  p { margin: 0; padding: 0 20px; line-height: 24px; }
  #viewport-prefetch { margin-top: 100vh; }
  #viewport-after-scroll { margin-top: 170vh; }
  #viewport-distant { margin-top: 210vh; }
</style>
<main><article>
  ${viewportBlocks.map(([id, block]) => `<p id="${id}">${block}</p>`).join('\n  ')}
</article></main>
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
let delayedPageTranslation;
let viewportStreamGate;
const slowResponseFinished = new Promise((resolve) => { finishSlowResponse = resolve; });
const delayedInlineResponses = new Map([
  ['inline slow', { gate: deferred(), finished: deferred() }],
  ['inline close slow', { gate: deferred(), finished: deferred() }],
]);
const textStreams = new Map([
  ['panel stream text', deferred()],
  ['inline stream text', deferred()],
]);

const languageResponses = new Map([
  ['panel switch language', { target: 'zh-CN', nextTarget: 'ja', translation: '側面パネルの日本語訳' }],
  ['panel stop', { target: 'ja', nextTarget: 'ja', translation: '停止後に再開した翻訳' }],
  ['inline switch language', { target: 'zh-CN', nextTarget: 'ja', translation: 'カードの日本語訳' }],
]);
for (const delayed of languageResponses.values()) {
  delayed.gate = deferred();
  delayed.finished = deferred();
}

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
  if (request.method === 'GET' && request.url === '/article-fixture') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.writeHead(200).end(articleFixturePage);
    return;
  }
  if (request.method === 'GET' && request.url === '/viewport-fixture') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.writeHead(200).end(viewportFixturePage);
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
  const instruction = body.messages.find((message) => message.role === 'system')?.content || '';
  const text = body.messages.find((message) => message.role === 'user')?.content;
  const target = instruction.match(/^Translate the user's text into (.+?)\. Preserve/)?.[1];
  requests.push({ text, target, model: body.model, stream: body.stream });
  response.setHeader('Content-Type', 'application/json');

  const pageTranslation = instruction.startsWith('Translate the following webpage text blocks into ');
  const pageSummary = instruction.startsWith('Summarize the following webpage text in ');
  if (pageTranslation || pageSummary) {
    const delayed = pageTranslation ? delayedPageTranslation : undefined;
    if (delayed) await delayed.gate.promise;
    const blocks = JSON.parse(text);
    if (pageTranslation && blocks.some((block) => viewportTranslations.has(block.text))) {
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.writeHead(200);
      for (const { id, text: block } of blocks) {
        const content = JSON.stringify({ id, text: viewportTranslations.get(block) }) + '\n';
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        if (block === viewportBlocks[0][1] && viewportStreamGate) await viewportStreamGate.promise;
        if (response.destroyed) return;
      }
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    const content = pageSummary ? articleSummary : JSON.stringify(blocks.map(({ id, text: block }) => ({
      id,
      text: articleTranslations[articleBlocks.indexOf(block)] || '未知段落译文',
    })).reverse());
    if (!response.destroyed) {
      response.writeHead(200).end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    delayed?.finished.resolve();
    return;
  }

  const textStream = textStreams.get(text);
  if (textStream) {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.writeHead(200);
    response.write('data: {"choices":[{"delta":{"content":"先显示这段，"}}]}\n\n');
    await textStream.promise;
    if (!response.destroyed) {
      response.end('data: {"choices":[{"delta":{"content":"然后完成。"},"finish_reason":"stop"}]}\n\n');
    }
    return;
  }

  if (text === 'retry me' && ++retryAttempts === 1) {
    response.writeHead(429).end(JSON.stringify({ error: 'sensitive upstream detail' }));
    return;
  }

  const languageResponse = languageResponses.get(text);
  if (languageResponse) {
    let content = target === languageResponse.nextTarget ? languageResponse.translation : '未知语言译文';
    const delayed = target === languageResponse.target && !languageResponse.started;
    if (delayed) {
      languageResponse.started = true;
      response.once('close', () => { languageResponse.aborted = !response.writableEnded; });
      await languageResponse.gate.promise;
      content = '迟到的旧译文';
    }
    if (!response.destroyed) {
      response.writeHead(200).end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    if (delayed) languageResponse.finished.resolve();
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

async function chooseLanguage(select, language) {
  // Headless Chrome cannot drive the system picker for a collapsed select.
  // Expose the same native options in-page and click to emit a trusted change.
  const originalSize = await select.evaluate((element) => {
    const size = element.getAttribute('size');
    element.size = element.options.length;
    return size;
  });
  try {
    await select.locator(`option[value="${language}"]`).click();
  } finally {
    await select.evaluate((element, size) => {
      if (size === null) element.removeAttribute('size');
      else element.setAttribute('size', size);
    }, originalSize);
  }
}

function requestedTargets(text) {
  return requests.filter((item) => item.text === text).map((item) => item.target);
}

function requestedPageText(since) {
  return requests.slice(since).flatMap(({ text }) => JSON.parse(text).map((block) => block.text));
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

async function triggerContextMenu(worker, tabId, menuItemId, selectionText) {
  return worker.evaluate(async ({ tabId: selectedTabId, menuItemId, selectionText }) => {
    const backgroundRouter = globalThis.__transmateTestRouter;
    if (!backgroundRouter?.onClicked) throw new Error('背景事件路由未导出');
    const tab = await chrome.tabs.get(selectedTabId);
    backgroundRouter.onClicked({
      menuItemId,
      selectionText,
      pageUrl: tab.url,
    }, tab);
    return true;
  }, { tabId, menuItemId, selectionText });
}

async function triggerShortcut(worker, tabId, command = 'translate-selection') {
  return worker.evaluate(async ({ tabId: selectedTabId, command }) => {
    const backgroundRouter = globalThis.__transmateTestRouter;
    if (!backgroundRouter?.onCommand) throw new Error('背景快捷键路由未导出');
    const tab = await chrome.tabs.get(selectedTabId);
    backgroundRouter.onCommand(command, tab);
    return true;
  }, { tabId, command });
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
// Expose the production router in the throwaway extension for menu simulation.
// The test opens sidepanel.html as a tab because the Chrome container needs a
// real menu gesture. Record each request to open the container here.
const testBackgroundPath = join(testExtensionDir, 'background.js');
await writeFile(testBackgroundPath,
  `${await readFile(testBackgroundPath, 'utf8')}\n` +
  `globalThis.__transmateTestRouter = backgroundRouter;
globalThis.__transmateTestSidePanelOpens = 0;
chrome.sidePanel.open = async () => {
  globalThis.__transmateTestSidePanelOpens += 1;
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
  assert.match(await options.locator('#form-status').textContent(), /连接正常.*尚未保存/);
  const saveTested = options.getByRole('button', { name: '保存已测试配置' });
  await saveTested.waitFor();
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
  await saveTested.click();
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
  assert.equal(saved.targetLanguage, 'zh-CN');
  assert.deepEqual(await options.evaluate(() => globalThis.__permissionRequests.map((item) => item.origins)), [
    ['http://127.0.0.1/*'],
    ['http://127.0.0.1/*'],
    ['http://127.0.0.1/*'],
  ]);

  await options.locator('#test-connection').click();
  await options.locator('#form-status').filter({ hasText: /连接正常.*当前配置已保存/ }).waitFor();
  assert.equal(await saveTested.isVisible(), false);
  await options.locator('#model').fill('different-draft');
  assert.equal(await options.locator('#form-status').isVisible(), false, '编辑表单后应清除之前的检测结果');
  await options.locator('#model').fill(saved.model);

  const panel = await context.newPage();
  const panelUrl = 'chrome-extension://' + extensionId + '/sidepanel.html';
  await panel.goto(panelUrl);
  await panel.locator('#source-text').fill('panel success');
  await panel.locator('#translate-button').click();
  await panel.locator('#result-text').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#result-text').textContent(), '侧栏译文');



  const originalPanelSize = panel.viewportSize();
  const beforeComparison = requests.length;
  await panel.setViewportSize({ width: 340, height: 780 });
  const compare = panel.getByRole('button', { name: '对照阅读' });
  await compare.click({ timeout: 1500 });
  const editing = panel.getByRole('button', { name: '返回编辑' });
  assert.equal(await editing.getAttribute('aria-pressed'), 'true');
  assert.equal(await panel.locator('#comparison-source').textContent(), 'panel success');
  assert.equal(await panel.locator('#source-text').isVisible(), false);
  assert.equal(await panel.locator('#copy-button').isEnabled(), true);
  assert.equal(await panel.locator('#result-text').textContent(), '侧栏译文');
  const columns = await panel.locator('#translation-layout').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  assert.equal(columns.split(' ').length, 1, '窄侧栏使用上下对照');
  await panel.setViewportSize({ width: 620, height: 780 });
  const wideColumns = await panel.locator('#translation-layout').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  assert.equal(wideColumns.split(' ').length, 2, '宽侧栏使用双列对照');
  await editing.click();
  assert.equal(await panel.locator('#source-text').inputValue(), 'panel success');
  assert.equal(await panel.locator('#source-text').isVisible(), true);
  await panel.setViewportSize(originalPanelSize);
  assert.equal(requests.length, beforeComparison, '切换对照布局不发送翻译请求');

  assert.equal(await options.evaluate(async () => (await chrome.storage.local.get('translationHistory')).translationHistory), undefined);
  await panel.getByText('翻译历史', { exact: true }).click();
  const historyEnabled = panel.getByRole('checkbox', { name: '在本机记录' });
  await historyEnabled.check();
  await waitUntil(async () => (await options.evaluate(async () =>
    (await chrome.storage.local.get('translationHistory')).translationHistory))?.enabled, '启用记录后写入本机设置');
  await panel.locator('#source-text').fill('history example');
  await panel.locator('#translate-button').click();
  await panel.locator('#translation-history-list summary').filter({ hasText: 'history example' }).click();
  const historyItem = panel.locator('#translation-history-list li');
  await historyItem.locator('.history-result').waitFor();
  await historyItem.getByRole('button', { name: '删除此条翻译历史' }).click();
  await historyItem.waitFor({ state: 'detached' });
  await panel.locator('#source-text').fill('another history example');
  await panel.locator('#translate-button').click();
  await historyItem.waitFor();
  await historyEnabled.uncheck();
  await historyItem.waitFor();
  await panel.getByRole('button', { name: '清空历史' }).click();
  await historyItem.waitFor({ state: 'detached' });

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

  await panel.locator('#source-text').fill('panel stream text');
  await panel.locator('#translate-button').click();
  const panelPreview = panel.locator('#result-preview');
  await panelPreview.filter({ hasText: '先显示这段，' }).waitFor();
  assert.equal(requests.find(({ text }) => text === 'panel stream text').stream, true);
  assert.equal(await panel.locator('#copy-button').isDisabled(), true);
  await panel.getByRole('button', { name: '停止', exact: true }).click();
  textStreams.get('panel stream text').resolve();
  await panelPreview.waitFor({ state: 'hidden' });
  assert.equal(await panel.locator('#result-text').isVisible(), false, '停止后不显示未完成的译文');

  const panelTarget = panel.locator('#target-language');
  const panelStop = panel.getByRole('button', { name: '停止', exact: true });
  const panelSource = panel.locator('#source-text');
  const panelResult = panel.locator('#result-text');
  await panel.getByRole('combobox', { name: '目标语言' }).waitFor({ timeout: 3000 });
  assert.equal(await panelTarget.locator('option:checked').textContent(), '简体中文（默认）');
  assert.equal(await panelStop.isVisible(), false, '完成翻译后应隐藏停止按钮');

  await panelSource.fill('panel switch language');
  await panel.locator('#translate-button').click();
  const panelSwitchResponse = languageResponses.get('panel switch language');
  await waitUntil(() => panelSwitchResponse.started, '侧栏已发出默认语言的待完成请求');
  await chooseLanguage(panelTarget, 'ja');
  await panelResult.filter({ hasText: panelSwitchResponse.translation }).waitFor();
  assert.deepEqual(requestedTargets('panel switch language'), [saved.targetLanguage, 'ja']);
  await waitUntil(() => panelSwitchResponse.aborted, '侧栏换语言后终止旧请求');
  panelSwitchResponse.gate.resolve();
  await panelSwitchResponse.finished.promise;
  assert.equal(await panelResult.textContent(), panelSwitchResponse.translation, '侧栏显示新语言的译文');
  assert.equal(await panelTarget.inputValue(), 'ja');

  await panelSource.fill('panel stop');
  await panel.locator('#translate-button').click();
  const panelStopResponse = languageResponses.get('panel stop');
  await waitUntil(() => panelStopResponse.started, '侧栏已在当前临时语言下发出待停止请求');
  await panelStop.click();
  await panelStop.waitFor({ state: 'hidden' });
  await waitUntil(() => panelStopResponse.aborted, '点击停止后终止侧栏请求');
  assert.equal(await panelSource.inputValue(), 'panel stop', '停止后应保留原文');
  assert.equal(await panel.locator('#translate-button').isEnabled(), true, '停止后应可再次翻译');
  assert.equal(await panel.locator('#copy-button').isDisabled(), true);
  panelStopResponse.gate.resolve();
  await panelStopResponse.finished.promise;
  assert.equal(await panelResult.isVisible(), false, '停止后应忽略迟到的译文');
  await panel.locator('#translate-button').click();
  await panelResult.filter({ hasText: panelStopResponse.translation }).waitFor();
  assert.deepEqual(requestedTargets('panel stop'), ['ja', 'ja'], '停止后保留侧栏的临时语言');
  await panel.reload();
  await waitUntil(async () => await panelTarget.locator('option:checked').textContent() === '简体中文（默认）',
    '重新打开侧栏后恢复默认语言');
  assert.deepEqual(await options.evaluate(async () => (await chrome.storage.local.get('settings')).settings), saved,
    '侧栏临时语言与停止操作不得保存设置');

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
  const inlineTarget = inlineHost.locator('.target-select');
  const initialPageCount = context.pages().length;

  await inlinePage.locator('#fixture-control').focus();
  await options.evaluate(() => chrome.storage.local.set({
    translationHistory: { enabled: true, entries: [] },
  }));
  let selectedText = await selectFixtureText(inlinePage, 'inline-first');
  assert.equal(selectedText, 'inline hello');
  await triggerContextMenu(worker, inlineTabId, 'translate-selection', selectedText);
  await inlineHost.locator('.result').waitFor({ state: 'visible' });
  assert.equal(await inlineHost.locator('.source').textContent(), selectedText);
  assert.equal(await inlineHost.locator('.result').textContent(), '页内译文');
  await waitUntil(async () => {
    const { translationHistory } = await options.evaluate(() => chrome.storage.local.get('translationHistory'));
    return translationHistory?.entries.some((entry) => entry.source === selectedText && entry.translation === '页内译文');
  }, '划词译文应写入已启用的本机历史');
  await options.evaluate(() => chrome.storage.local.set({
    translationHistory: { enabled: false, entries: [] },
  }));
  assert.equal(await inlineTarget.inputValue(), saved.targetLanguage);
  assert.equal(await inlineHost.getByRole('button', { name: '复制译文' }).isVisible(), true);
  assert.equal(requests.filter((item) => item.text === selectedText).length, 1);
  assert.equal(inlinePage.url(), inlineUrl, '页内翻译不得跳转当前网页');
  assert.equal(context.pages().length, initialPageCount, '页内翻译不得新建窗口或标签页');
  const originalBottom = await inlinePage.locator('#inline-first').evaluate((element) => element.getBoundingClientRect().bottom);
  await waitUntil(async () => (await inlineHost.boundingBox())?.y > originalBottom,
    '空余空间充足时，浮层应显示在选区下方');
  const bounds = await inlineHost.boundingBox();
  const viewport = inlinePage.viewportSize();
  assert.ok(bounds && viewport && bounds.x >= 0 && bounds.y >= 0
    && bounds.x + bounds.width <= viewport.width
    && bounds.y + bounds.height <= viewport.height,
  '浮层应保持在可见区域内');
  assert.ok(bounds.height < 190, '短句译文应使用紧凑浮层');
  assert.ok(await inlineHost.evaluate((host) => {
    const shadow = host.shadowRoot;
    return parseFloat(getComputedStyle(shadow.querySelector('.result')).fontSize)
      > parseFloat(getComputedStyle(shadow.querySelector('.source')).fontSize);
  }), '译文字号应大于原文预览');
  assert.equal(await inlinePage.evaluate(() => document.activeElement.id), 'fixture-control',
    '右键触发浮层应保留网页焦点');

  const inlineCard = inlineHost.getByRole('dialog');
  await inlinePage.emulateMedia({ colorScheme: 'light' });
  const lightBackground = await inlineCard.evaluate((element) => getComputedStyle(element).backgroundColor);
  await inlinePage.emulateMedia({ colorScheme: 'dark' });
  assert.notEqual(await inlineCard.evaluate((element) => getComputedStyle(element).backgroundColor), lightBackground,
    '浮层应随系统切换深色背景');
  await inlinePage.emulateMedia({ colorScheme: null });

  await inlinePage.evaluate(() => {
    window.getSelection().removeAllRanges();
    window.scrollTo(0, 56);
  });
  await waitUntil(async () => Math.abs((await inlineHost.boundingBox())?.y - (bounds.y - 56)) <= 2,
    '清除选区后，滚动页面仍应跟随原选文');
  await selectFixtureText(inlinePage, 'shortcut-paragraph');
  const anchoredY = await inlineHost.evaluate(async (host) => {
    window.scrollTo(0, 72);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return host.getBoundingClientRect().top;
  });
  assert.ok(Math.abs(anchoredY - (bounds.y - 72)) <= 2, '滚动时已有浮层应忽略后续选区');
  await inlinePage.evaluate(() => window.scrollTo(0, 0));

  await inlinePage.evaluate(() => {
    const shadow = document.querySelector('#transmate-inline-host').shadowRoot;
    [...shadow.querySelectorAll('button')].find((button) => /^(重新翻译|重试)$/.test(button.textContent.trim())).click();
  });
  await inlinePage.waitForTimeout(150);
  assert.equal(requests.filter((item) => item.text === 'inline hello').length, 1,
    '网页脚本合成点击不得触发额外付费请求');

  // Simulate MV3 worker memory loss: retry must recover the selection from
  // extension session storage rather than relying on a module global.
  await worker.evaluate(() => globalThis.__transmateTestRouter.activeByTab.clear());
  await inlineHost.getByRole('button', { name: /^(重新翻译|重试)$/ }).click();
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

  await inlineHost.getByRole('button', { name: /^(去设置|设置)$/ }).evaluate((button) => button.click());
  await inlinePage.waitForTimeout(150);
  assert.equal(context.pages().length, initialPageCount, '网页脚本合成点击不得打开设置页');

  await inlineHost.getByRole('button', { name: '关闭翻译' }).click();
  await inlineHost.waitFor({ state: 'detached' });

  selectedText = await selectFixtureText(inlinePage, 'inline-slow');
  await triggerContextMenu(worker, inlineTabId, 'translate-selection', selectedText);
  await inlineHost.locator('.loading').waitFor({ state: 'visible' });
  await waitUntil(() => requests.some((item) => item.text === 'inline slow'), '延迟页内请求已发出');
  selectedText = await selectFixtureText(inlinePage, 'inline-latest');
  await triggerContextMenu(worker, inlineTabId, 'translate-selection', selectedText);
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
  await triggerContextMenu(worker, inlineTabId, 'translate-selection', selectedText);
  await waitUntil(() => requests.some((item) => item.text === 'inline close slow'), '关闭前的页内请求已发出');
  await inlineHost.getByRole('button', { name: '停止翻译' }).click();
  await inlineHost.waitFor({ state: 'detached' });
  delayedInlineResponses.get('inline close slow').gate.resolve();
  await delayedInlineResponses.get('inline close slow').finished.promise;
  await inlinePage.waitForTimeout(150);
  assert.equal(await inlineHost.count(), 0, '关闭后迟到的译文不得重新打开浮层');
  assert.equal(context.pages().length, initialPageCount, '页内流程不得新建窗口或标签页');
  assert.equal(await worker.evaluate(() => globalThis.__transmateTestSidePanelOpens), 0,
    '普通网页的页内翻译不得打开侧栏');

  selectedText = await selectFixtureText(inlinePage, 'inline-switch-language');
  await triggerContextMenu(worker, inlineTabId, 'translate-selection', selectedText);
  const inlineSwitchResponse = languageResponses.get('inline switch language');
  await waitUntil(() => inlineSwitchResponse.started, '卡片已发出默认语言的待完成请求');
  assert.equal(await inlineTarget.inputValue(), saved.targetLanguage);
  await inlineTarget.selectOption('fr');
  await inlinePage.waitForTimeout(150);
  assert.deepEqual(requestedTargets(selectedText), [saved.targetLanguage],
    '网页脚本合成的语言切换不得发送付费请求');
  await chooseLanguage(inlineTarget, 'ja');
  await inlineHost.locator('.result').filter({ hasText: inlineSwitchResponse.translation }).waitFor();
  await waitUntil(() => inlineSwitchResponse.aborted, '卡片换语言后终止旧请求');
  inlineSwitchResponse.gate.resolve();
  await inlineSwitchResponse.finished.promise;
  assert.equal(await inlineHost.locator('.result').textContent(), inlineSwitchResponse.translation, '卡片显示新语言的译文');
  assert.equal(await inlineHost.locator('.source').textContent(), selectedText);
  assert.equal(await inlineTarget.inputValue(), 'ja');

  await worker.evaluate(() => globalThis.__transmateTestRouter.activeByTab.clear());
  await inlineHost.getByRole('button', { name: /^(重新翻译|重试)$/ }).click();
  await waitUntil(() => requestedTargets(selectedText).length === 3, '重试应在后台休眠后继续使用卡片临时语言');
  await inlineHost.locator('.result').filter({ hasText: inlineSwitchResponse.translation }).waitFor();
  assert.deepEqual(requestedTargets(selectedText), [saved.targetLanguage, 'ja', 'ja']);
  assert.equal(await options.evaluate(async () => (await chrome.storage.local.get('settings')).settings.targetLanguage),
    saved.targetLanguage, '卡片临时语言不得修改默认设置');

  const openPanelButton = inlineHost.getByRole('button', { name: '在侧栏打开' });
  await openPanelButton.evaluate((button) => button.click());
  assert.equal(await worker.evaluate(() => globalThis.__transmateTestSidePanelOpens), 0,
    '网页脚本合成点击不得打开侧栏');
  await worker.evaluate(() => {
    globalThis.__transmateTestRouter.activeByTab.clear();
    const open = chrome.sidePanel.open;
    chrome.sidePanel.open = (details) => {
      chrome.sidePanel.open = open;
      open(details);
      return new Promise((resolve) => { globalThis.__releaseCardPanelOpen = resolve; });
    };
  });
  await openPanelButton.click();
  await waitUntil(async () => await worker.evaluate(() => globalThis.__transmateTestSidePanelOpens) === 1,
    '手动点击应打开侧栏');
  await inlinePage.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await inlineHost.count(), 1, '打开侧栏造成的失焦不得提前清空待交接译文');
  await worker.evaluate(() => globalThis.__releaseCardPanelOpen());
  await waitUntil(async () => await panelResult.textContent() === inlineSwitchResponse.translation,
    '侧栏应收到已有的日语译文');
  assert.equal(await panelSource.inputValue(), selectedText);
  assert.equal(await panelTarget.inputValue(), 'ja');
  assert.deepEqual(requestedTargets(selectedText), [saved.targetLanguage, 'ja', 'ja'],
    '交接原文和已有译文不得再次调用服务');
  assert.equal(await panel.locator('#copy-button').isEnabled(), true);
  await inlineHost.waitFor({ state: 'detached' });
  assert.equal(await worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null))
    .some((key) => key.startsWith('pendingSelection:'))), false, '侧栏消费后应清除一次性交接记录');

  selectedText = await selectFixtureText(inlinePage, 'inline-stream-text');
  await triggerContextMenu(worker, inlineTabId, 'translate-selection', selectedText);
  await inlineHost.locator('.preview').filter({ hasText: '先显示这段，' }).waitFor();
  assert.equal(requests.find(({ text }) => text === selectedText).stream, true);
  assert.equal(await inlineHost.getByRole('button', { name: '复制译文' }).isVisible(), false);
  textStreams.get('inline stream text').resolve();
  await inlineHost.locator('.result').filter({ hasText: '先显示这段，然后完成。' }).waitFor();
  assert.equal(await inlineHost.locator('.preview').isVisible(), false);
  await inlineHost.getByRole('button', { name: '关闭翻译' }).click();
  await inlineHost.waitFor({ state: 'detached' });

  // The browser reserves native extension shortcuts, so invoke the registered
  // route directly while its selection reader and UI run in real page frames.
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  const shortcutCommand = commands.find((command) => command.name === 'translate-selection');
  assert.ok(shortcutCommand, 'manifest 必须注册划词翻译快捷键');
  assert.match(shortcutCommand.shortcut,
    process.platform === 'darwin' ? /^(?:⌥|Option\+|Alt\+)1$/ : /^Ctrl\+Shift\+Y$/,
    'Chrome 必须实际分配当前平台的默认快捷键');
  const pageCommand = commands.find((command) => command.name === 'translate-page');
  assert.ok(pageCommand, 'manifest 必须注册整页双语翻译快捷键');
  assert.match(pageCommand.shortcut, process.platform === 'darwin' ? /^(?:⌥|Option\+|Alt\+)2$/ : /^Ctrl\+Shift\+2$/,
    'Chrome 应分配当前平台的整页翻译快捷键');
  const summaryCommand = commands.find((command) => command.name === 'summarize-page');
  assert.ok(summaryCommand, 'manifest 必须注册网页总结快捷键');
  assert.match(summaryCommand.shortcut, process.platform === 'darwin' ? /^(?:⌥|Option\+|Alt\+)3$/ : /^Ctrl\+Shift\+3$/,
    'Chrome 应分配当前平台的网页总结快捷键');
  await inlinePage.bringToFront();
  selectedText = await selectFixtureText(inlinePage, 'shortcut-paragraph');
  await triggerShortcut(worker, inlineTabId);
  await waitUntil(async () => await inlineHost.locator('.result').isVisible()
    && await inlineHost.locator('.result').textContent() === '快捷键段落译文',
  '快捷键翻译普通段落');
  assert.equal(await inlineHost.locator('.source').textContent(), selectedText);
  assert.deepEqual(requestedTargets(selectedText), [saved.targetLanguage], '新选区应恢复默认语言');
  assert.equal(await inlineTarget.inputValue(), saved.targetLanguage);
  assert.ok(await inlineHost.evaluate((host) => host.shadowRoot.querySelector('.card').contains(host.shadowRoot.activeElement)),
    '快捷键触发应将焦点移入浮层');
  await inlinePage.keyboard.press('Tab');
  assert.equal(await inlineHost.evaluate((host) => host.shadowRoot.activeElement?.getAttribute('aria-label')), '目标语言',
    'Tab 应到达浮层目标语言选项');
  await inlinePage.keyboard.press('Tab');
  assert.equal(await inlineHost.evaluate((host) => host.shadowRoot.activeElement?.getAttribute('aria-label')), '关闭翻译',
    'Tab 应到达浮层关闭操作');
  await inlinePage.keyboard.press('Enter');
  await inlineHost.waitFor({ state: 'detached' });

  selectedText = await inlinePage.locator('#shortcut-input').evaluate((input) => {
    window.getSelection()?.removeAllRanges();
    input.focus();
    input.setSelectionRange(0, input.value.length);
    return input.value.slice(input.selectionStart, input.selectionEnd);
  });
  assert.equal(selectedText, 'shortcut input');
  await triggerShortcut(worker, inlineTabId);
  await waitUntil(async () => await inlineHost.locator('.result').isVisible()
    && await inlineHost.locator('.result').textContent() === '快捷键输入译文',
  '快捷键翻译输入框选文');
  assert.equal(await inlineHost.locator('.source').textContent(), selectedText);
  assert.equal(requests.filter((item) => item.text === 'shortcut input').length, 1);
  assert.equal(await inlinePage.evaluate(() => document.activeElement?.id), 'transmate-inline-host',
    '再次按快捷键前，焦点应仍在浮层内');
  await inlinePage.locator('#shortcut-input').evaluate((input) => {
    window.getSelection()?.removeAllRanges();
    input.setSelectionRange(0, input.value.length);
  });
  assert.equal(await inlinePage.evaluate(() => window.getSelection()?.toString()), '',
    '输入框失焦后，页面选区可能已清除');
  await worker.evaluate(() => globalThis.__transmateTestRouter.activeByTab.clear());
  await triggerShortcut(worker, inlineTabId);
  await waitUntil(async () => requests.filter((item) => item.text === 'shortcut input').length === 2
    && await inlineHost.locator('.result').isVisible()
    && await inlineHost.locator('.result').textContent() === '快捷键输入译文',
  '浮层持有焦点且后台已休眠时，再按快捷键应翻译同一输入框选文');
  await inlinePage.keyboard.press('Escape');
  await inlineHost.waitFor({ state: 'detached' });
  assert.deepEqual(await inlinePage.locator('#shortcut-input').evaluate((input) => ({
    focused: document.activeElement === input,
    selected: input.value.slice(input.selectionStart, input.selectionEnd),
  })), { focused: true, selected: selectedText }, 'Escape 应将焦点还给原输入框并保留选区');

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
  await triggerShortcut(worker, inlineTabId);
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
  await triggerShortcut(worker, inlineTabId);
  const emptyShortcutHint = inlineHost.locator('.error');
  await emptyShortcutHint.waitFor({ state: 'visible' });
  assert.match(await emptyShortcutHint.textContent(), /请先选中文字/);
  assert.equal(requests.length, beforeEmptyShortcut, '空选文快捷键不得调用 AI 服务');
  assert.equal(context.pages().length, initialPageCount, '快捷键翻译不得新建窗口或标签页');
  await inlinePage.keyboard.press('Escape');
  await inlineHost.waitFor({ state: 'detached' });

  await inlinePage.setViewportSize({ width: 320, height: 440 });
  await inlinePage.locator('#inline-long').evaluate((source) => {
    window.scrollBy(0, source.getBoundingClientRect().bottom - window.innerHeight + 24);
  });
  selectedText = await selectFixtureText(inlinePage, 'inline-long');
  const lastSourceLineTop = await inlinePage.evaluate(() => {
    const rects = window.getSelection().getRangeAt(0).getClientRects();
    return rects[rects.length - 1].top;
  });
  await triggerContextMenu(worker, inlineTabId, 'translate-selection', selectedText);
  await inlineHost.locator('.result').waitFor({ state: 'visible' });
  await waitUntil(async () => {
    const card = await inlineHost.boundingBox();
    return card && card.y + card.height <= lastSourceLineTop;
  }, '选区在视口底部时，浮层应翻到选区上方');
  const collapsedHeight = await inlineHost.locator('.source').evaluate((source) => source.clientHeight);
  await inlineHost.getByRole('button', { name: '展开原文' }).click();
  const expanded = await inlineHost.evaluate(async (host) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { top, right, bottom, left } = host.getBoundingClientRect();
    const source = host.shadowRoot.querySelector('.source');
    const body = host.shadowRoot.querySelector('.body');
    return {
      sourceHeight: source.clientHeight,
      sourceScrollHeight: source.scrollHeight,
      bodyHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      inViewport: top >= 0 && left >= 0 && right <= window.innerWidth && bottom <= window.innerHeight,
    };
  });
  assert.ok(expanded.sourceHeight > collapsedHeight, '展开后应显示完整原文');
  assert.ok(expanded.sourceScrollHeight <= expanded.sourceHeight + 1, '原文不应形成独立滚动区');
  assert.ok(expanded.bodyScrollHeight > expanded.bodyHeight, '长文使用统一的正文滚动区');
  assert.ok(expanded.inViewport, '窄屏展开原文后浮层仍应留在视口内');
  const scrollRegion = inlineHost.getByRole('region', { name: '翻译内容' });
  assert.equal(await scrollRegion.getAttribute('tabindex'), '0', '正文有溢出时应能通过 Tab 聚焦');
  await scrollRegion.focus();
  await scrollRegion.evaluate((region) => { region.scrollTop = 0; });
  await inlinePage.keyboard.press('End');
  await waitUntil(() => scrollRegion.evaluate((region) => region.scrollTop > 0), '长文可通过键盘滚动');
  await inlineHost.getByRole('button', { name: '收起原文' }).click();
  assert.equal(await inlineHost.locator('.source').evaluate((source) => source.clientHeight), collapsedHeight);
  await inlineHost.getByRole('button', { name: '关闭翻译' }).click();
  await inlineHost.waitFor({ state: 'detached' });

  await panel.bringToFront();
  const panelPageStatus = panel.locator('#page-action-status');
  const beforeUnsupportedPage = requests.length;
  await panel.getByRole('button', { name: '翻译本页' }).evaluate((button) => button.click());
  await panelPageStatus.filter({ hasText: '无法访问当前网页' }).waitFor();
  assert.equal(requests.length, beforeUnsupportedPage, '受限页面不得发出翻译请求');

  const articleUrl = new URL('/article-fixture', endpoint).href;
  const [articlePage, articleTab] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }),
    worker.evaluate(({ url, windowId }) => chrome.tabs.create({ url, windowId, active: true }), {
      url: articleUrl, windowId: firstWindowId,
    }),
  ]);
  await articlePage.waitForURL(articleUrl);
  await articlePage.locator('#article-intro').waitFor();
  const pageStatus = articlePage.locator('#transmate-page-status');
  const pageTranslations = articlePage.locator('[data-transmate-page-translation]');
  const pageRequestCount = requests.length;

  // The panel is hosted in a tab here. Dispatch the click without focusing its
  // test host so the article remains the same active tab as in a native panel.
  await panel.getByRole('button', { name: '翻译本页' }).evaluate((button) => button.click());
  await panelPageStatus.filter({ hasText: '已在网页上启动双语翻译' }).waitFor();
  await pageStatus.getByRole('button', { name: '移除译文' }).waitFor();
  assert.deepEqual(await pageTranslations.allTextContents(), articleTranslations);
  assert.equal(await articlePage.locator('#article-intro').textContent(), articleBlocks[1]);
  assert.equal(await articlePage.locator('#article-intro a').getAttribute('href'), '#article-tip');
  assert.equal(await articlePage.locator('#unexpected-page-markup').count(), 0, '模型译文必须按纯文本渲染');
  assert.deepEqual(
    requestedPageText(pageRequestCount),
    articleBlocks,
    '应按正文顺序发送文字，过滤隐藏、可编辑和导航内容',
  );

  await panel.getByRole('button', { name: '总结本页' }).evaluate((button) => button.click());
  await panel.locator('#page-summary-text').filter({ hasText: articleSummary }).waitFor();
  assert.equal(await worker.evaluate(() => globalThis.__transmateTestSidePanelOpens), 0,
    '侧栏内总结不需要再次打开侧栏');

  const summaryRequestCount = requests.length;
  const opensBeforeSummary = await worker.evaluate(() => globalThis.__transmateTestSidePanelOpens);
  await triggerContextMenu(worker, articleTab.id, 'summarize-page');
  await waitUntil(async () => requests.length > summaryRequestCount
    && await panel.locator('#page-summary-text').isVisible()
    && await panel.locator('#page-summary-text').textContent() === articleSummary,
  '页面总结出现在发起操作的窗口');
  assert.equal(await secondPanel.locator('#page-summary').isVisible(), false,
    '页面总结不得显示在另一个窗口');
  assert.equal(await worker.evaluate(() => globalThis.__transmateTestSidePanelOpens), opensBeforeSummary + 1,
    '总结入口应打开侧栏');
  assert.deepEqual(
    requestedPageText(summaryRequestCount),
    articleBlocks,
    '有译文时总结应只使用页面正文',
  );
  assert.deepEqual(await pageTranslations.allTextContents(), articleTranslations,
    '查看总结时保留已显示的双语段落');

  const beforeSummaryShortcut = requests.length;
  await triggerShortcut(worker, articleTab.id, 'summarize-page');
  await waitUntil(async () => requests.length > beforeSummaryShortcut
    && await panel.locator('#page-summary-text').isVisible()
    && await panel.locator('#page-summary-text').textContent() === articleSummary,
  '快捷键应在当前窗口侧栏显示网页重点');
  assert.equal(await secondPanel.locator('#page-summary').isVisible(), false,
    '快捷键总结不得显示在另一个窗口');
  assert.equal(await worker.evaluate(() => globalThis.__transmateTestSidePanelOpens), opensBeforeSummary + 2,
    '快捷键总结应打开侧栏');

  const removePageTranslation = pageStatus.getByRole('button', { name: '移除译文' });
  await removePageTranslation.evaluate((button) => button.click());
  assert.equal(await removePageTranslation.isVisible(), true, '网页脚本不得触发移除译文');
  await removePageTranslation.click();
  await pageStatus.waitFor({ state: 'detached' });
  assert.equal(await pageTranslations.count(), 0);
  assert.equal(await articlePage.locator('#article-intro').textContent(), articleBlocks[1]);

  delayedPageTranslation = { gate: deferred(), finished: deferred() };
  const beforeDelayedPageRequest = requests.length;
  await triggerContextMenu(worker, articleTab.id, 'translate-page');
  await waitUntil(() => requests.length > beforeDelayedPageRequest, '延迟整页翻译请求已发出');
  await pageStatus.getByRole('button', { name: '取消翻译' }).click();
  await pageStatus.waitFor({ state: 'detached' });
  delayedPageTranslation.gate.resolve();
  await delayedPageTranslation.finished.promise;
  delayedPageTranslation = undefined;
  await articlePage.waitForTimeout(150);
  assert.equal(await pageStatus.count(), 0, '取消后迟到的译文不得重新打开状态栏');
  assert.equal(await pageTranslations.count(), 0, '取消后迟到的译文不得显示');

  await triggerShortcut(worker, articleTab.id, 'translate-page');
  await pageStatus.getByRole('button', { name: '移除译文' }).waitFor();
  assert.deepEqual(await pageTranslations.allTextContents(), articleTranslations, '快捷键应翻译当前页正文');
  await articlePage.evaluate(() => history.pushState({}, '', '/article-next'));
  await pageStatus.waitFor({ state: 'detached' });
  assert.equal(await pageTranslations.count(), 0, '页内路由变化应清理旧译文');
  await panel.locator('#page-summary').waitFor({ state: 'hidden' });

  const viewportUrl = new URL('/viewport-fixture', endpoint).href;
  await articlePage.goto(viewportUrl);
  await articlePage.bringToFront();
  const prefetchParagraph = articlePage.locator('#viewport-prefetch');
  assert.equal(await prefetchParagraph.evaluate((element) => element.getBoundingClientRect().top > innerHeight), true,
    '预取段落应该在初始视口下方');

  viewportStreamGate = deferred();
  const viewportRequestCount = requests.length;
  const initialViewportBlocks = viewportBlocks.slice(0, 3);
  await triggerContextMenu(worker, articleTab.id, 'translate-page');
  await pageTranslations.filter({ hasText: viewportBlocks[0][2] }).waitFor({ timeout: 6000 });
  assert.equal(requests[viewportRequestCount].stream, true, '网页翻译应向 AI 服务请求流式响应');
  assert.deepEqual(await pageTranslations.allTextContents(), [viewportBlocks[0][2]],
    'AI 响应尚未结束时应该已经出现第一段译文');
  viewportStreamGate.resolve();
  viewportStreamGate = undefined;

  await pageTranslations.filter({ hasText: viewportBlocks[2][2] }).waitFor({ timeout: 6000 });
  await pageStatus.getByRole('button', { name: '移除译文' }).waitFor({ timeout: 6000 });
  await articlePage.waitForTimeout(400);
  assert.deepEqual(requestedPageText(viewportRequestCount), initialViewportBlocks.map(([, text]) => text),
    '静止时仅发送可见段落和附近的预取段落');
  assert.deepEqual(await pageTranslations.allTextContents(), initialViewportBlocks.map(([, , translation]) => translation));

  const middleParagraph = articlePage.locator('#viewport-after-scroll');
  const scrollDistance = await middleParagraph.evaluate((element) => element.getBoundingClientRect().top - 180);
  await articlePage.mouse.move(220, 180);
  await articlePage.mouse.wheel(0, scrollDistance);
  await pageTranslations.filter({ hasText: viewportBlocks[3][2] }).waitFor({ timeout: 6000 });
  await pageStatus.getByRole('button', { name: '移除译文' }).waitFor({ timeout: 6000 });
  await articlePage.waitForTimeout(400);
  const scrolledViewportBlocks = viewportBlocks.slice(0, 4);
  assert.deepEqual(requestedPageText(viewportRequestCount), scrolledViewportBlocks.map(([, text]) => text),
    '滚动后仅追加新到达的段落，远处内容继续等待');
  assert.deepEqual(await pageTranslations.allTextContents(), scrolledViewportBlocks.map(([, , translation]) => translation));

  const longSummaryRequestCount = requests.length;
  await triggerContextMenu(worker, articleTab.id, 'summarize-page');
  await panel.locator('#page-summary-text').waitFor({ state: 'visible' });
  assert.deepEqual(requestedPageText(longSummaryRequestCount), viewportBlocks.map(([, text]) => text),
    '长网页总结仍应读取整个页面正文');

  const beforeChangedViewport = requests.length;
  const changedParagraph = articlePage.locator('#viewport-distant');
  const distanceToChanged = await changedParagraph.evaluate((element) => {
    element.firstChild.data = 'The initial text has changed within this paragraph.';
    return element.getBoundingClientRect().top - 180;
  });
  await articlePage.mouse.wheel(0, distanceToChanged);
  await pageStatus.getByText('网页正文已变动，请重新启动翻译。').waitFor({ timeout: 6000 });
  assert.equal(requests.length, beforeChangedViewport, '正文原位变动后不得发送已经过期的段落');

  console.log('PASS: 连接检测、模拟授权与保存、侧栏译文、临时目标语言、停止翻译、重试、双窗口选文、页内划词浮层、快捷键翻译、按视口流式翻译和网页重点总结');
  console.log('Mock POST requests: ' + requests.map((item) => item.text).join(', '));
} finally {
  releaseSlowResponse?.();
  delayedPageTranslation?.gate.resolve();
  viewportStreamGate?.resolve();
  for (const delayed of delayedInlineResponses.values()) delayed.gate.resolve();
  for (const delayed of languageResponses.values()) delayed.gate.resolve();
  for (const stream of textStreams.values()) stream.resolve();
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}
