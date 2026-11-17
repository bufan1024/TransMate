import { readLocalPdf } from './local-pdf.js';
import { MAX_TEXT_LENGTH } from './translator.js';

export function createLocalPdfPanel(root, useSnippet) {
  const picker = root.querySelector('#pdf-file');
  const status = root.querySelector('#pdf-status');
  const pagesField = root.querySelector('#pdf-pages');
  const pagePicker = root.querySelector('#pdf-page');
  const preview = root.querySelector('#pdf-text');
  const use = root.querySelector('#pdf-use-selection');
  const close = root.querySelector('#pdf-close');
  const selectionHint = root.querySelector('#pdf-selection-hint');

  const chromeVersion = /\b(?:Chrome|Chromium)\/(\d+)/.exec(globalThis.navigator?.userAgent || '');
  if (chromeVersion && Number(chromeVersion[1]) < 125) {
    picker.disabled = true;
    status.textContent = '本地 PDF 文本读取需要 Chrome 125 或更高版本。';
    return;
  }

  let request = null;
  let document = null;
  let filename = '';

  function getSelection() {
    return preview.value.slice(preview.selectionStart, preview.selectionEnd).trim();
  }

  function showSelection() {
    const length = getSelection().length;
    use.disabled = !length || length > MAX_TEXT_LENGTH;
    selectionHint.hidden = length <= MAX_TEXT_LENGTH;
    selectionHint.textContent = '一次可使用最多 ' + MAX_TEXT_LENGTH.toLocaleString('zh-CN') + ' 字符，请缩小选区。';
  }

  function showPage() {
    const page = document?.pages[Number(pagePicker.value) - 1];
    if (!page) return;
    preview.hidden = use.hidden = !page.text;
    preview.value = page.text;
    preview.setSelectionRange(0, 0);
    showSelection();
    const statusLines = [filename + ' · 第 ' + page.number + '/' + document.totalPages + ' 页'];
    if (!page.text) statusLines.push('本页没有可提取的文字。扫描件需要 OCR。');
    if (page.truncated) statusLines.push('本页超过预览上限，仅显示开头文字。');
    if (document.pages.length < document.totalPages) {
      statusLines.push('达到文件预览上限，已读取前 ' + document.pages.length + ' 页。');
    }
    status.textContent = statusLines.join('\n');
  }

  function clear() {
    request?.abort();
    request = null;
    document = null;
    filename = '';
    status.textContent = '';
    preview.value = '';
    pagePicker.replaceChildren();
    pagesField.hidden = true;
    close.hidden = true;
  }

  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    clear();
    filename = file.name;
    const job = new AbortController();
    request = job;
    close.hidden = false;
    close.textContent = '取消读取';
    status.textContent = '正在本机打开 PDF…';

    try {
      const result = await readLocalPdf(file, {
        signal: job.signal,
        onProgress: (page, total) => {
          if (request === job) status.textContent = '正在读取第 ' + page + '/' + total + ' 页…';
        },
      });
      if (request !== job) return;
      document = result;
      for (const { number } of result.pages) {
        const option = root.createElement('option');
        option.value = String(number);
        option.textContent = '第 ' + number + ' 页';
        pagePicker.append(option);
      }
      pagePicker.value = '1';
      pagesField.hidden = false;
      close.textContent = '关闭文档';
      showPage();
    } catch (error) {
      if (request !== job) return;
      status.textContent = error.message;
      close.hidden = true;
    } finally {
      if (request === job) request = null;
    }
  });

  close.addEventListener('click', clear);
  pagePicker.addEventListener('change', showPage);
  preview.addEventListener('select', showSelection);
  preview.addEventListener('keyup', showSelection);
  preview.addEventListener('pointerup', showSelection);
  use.addEventListener('click', () => {
    const snippet = getSelection();
    if (snippet && snippet.length <= MAX_TEXT_LENGTH) useSnippet(snippet);
  });
  globalThis.window?.addEventListener('pagehide', () => request?.abort());
}
