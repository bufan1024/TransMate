export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 60;
const MAX_PAGE_TEXT = 30_000;
const MAX_DOCUMENT_TEXT = 120_000;
const PDF_TIMEOUT_MS = 18_000;

const assetBase = new URL('../vendor/pdfjs/', import.meta.url);
const genericError = '无法读取 PDF。请确认文件完整，或尝试另一个 PDF。';
class PdfInputError extends Error {}

class LocalPdfAssets {
  async fetch({ kind, filename }) {
    if (kind !== 'cMapUrl' || !/^[\w-]+\.bcmap$/.test(filename)) {
      throw new Error('PDF resource is outside the packaged character maps.');
    }
    const url = new URL('cmaps/' + filename, assetBase);
    const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('PDF resource unavailable.');
    return new Uint8Array(await response.arrayBuffer());
  }
}

function sliceText(text, end) {
  if (end <= 0) return '';
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

async function readPageText(page, limit, signal) {
  const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
  let text = '';
  let truncated = false;
  try {
    while (!truncated) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (typeof item.str !== 'string') continue;
        const fragment = item.str + (item.hasEOL ? '\n' : '');
        const remaining = limit - text.length;
        if (fragment.length > remaining) {
          text += sliceText(fragment, remaining);
          truncated = true;
          break;
        }
        text += fragment;
      }
    }
    if (truncated) await reader.cancel();
    return { text: text.trim(), truncated };
  } finally {
    reader.releaseLock();
  }
}

export async function readLocalPdf(file, { signal, onProgress } = {}) {
  if (file.size > MAX_PDF_BYTES) throw new PdfInputError('PDF 须小于或等于 20 MB。');
  if (!file.size) throw new PdfInputError('文件为空，请选择有内容的 PDF。');
  const controller = new AbortController();
  const { signal: localSignal } = controller;
  const cancel = () => controller.abort(signal.reason);
  let worker;
  let pdfWorker;
  let task;

  if (signal?.aborted) throw signal.reason;
  signal?.addEventListener('abort', cancel, { once: true });
  const interrupted = new Promise((_, reject) => {
    localSignal.addEventListener('abort', () => {
      worker?.terminate();
      reject(localSignal.reason);
    }, { once: true });
  });
  const timer = setTimeout(() => {
    controller.abort(new PdfInputError('读取 PDF 超时，请选用较小或页数较少的文件。'));
  }, PDF_TIMEOUT_MS);

  async function extract() {
    const data = new Uint8Array(await file.arrayBuffer());
    localSignal.throwIfAborted();
    if (!new TextDecoder().decode(data.subarray(0, 1024)).includes('%PDF-')) {
      throw new PdfInputError('此文件不是 PDF，请选择 PDF 文件。');
    }
    const { getDocument, PDFWorker, VerbosityLevel } = await import('../vendor/pdfjs/pdf.min.mjs');
    localSignal.throwIfAborted();
    worker = new Worker(new URL('pdf.worker.min.mjs', assetBase), { type: 'module' });
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      controller.abort(new PdfInputError(genericError));
    }, { once: true });
    pdfWorker = PDFWorker.create({ port: worker, verbosity: VerbosityLevel.ERRORS });
    task = getDocument({
      data, worker: pdfWorker, BinaryDataFactory: LocalPdfAssets,
      cMapUrl: new URL('cmaps/', assetBase).href,
      useWorkerFetch: false,
      useWasm: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableWorkerRendering: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      enableXfa: false,
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true,
      stopAtErrors: true,
      verbosity: VerbosityLevel.ERRORS,
    });
    const document = await task.promise;
    localSignal.throwIfAborted();
    const maxPages = Math.min(document.numPages, MAX_PDF_PAGES);
    const pages = [];
    let remaining = MAX_DOCUMENT_TEXT;
    for (let number = 1; number <= maxPages && remaining > 0; number += 1) {
      localSignal.throwIfAborted();
      onProgress?.(number, maxPages);
      const page = await document.getPage(number);
      const extracted = await readPageText(page, Math.min(MAX_PAGE_TEXT, remaining), localSignal);
      remaining -= extracted.text.length;
      pages.push({ number, ...extracted });
      page.cleanup();
    }
    return { pages, totalPages: document.numPages };
  }

  try {
    return await Promise.race([extract(), interrupted]);
  } catch (error) {
    if (localSignal.aborted || error instanceof PdfInputError) throw error;
    if (error?.name === 'PasswordException') throw new PdfInputError('此 PDF 需要密码，请选择已解锁的本地副本。');
    throw new PdfInputError(genericError);
  } finally {
    if (task && !localSignal.aborted) {
      await Promise.race([task.destroy(), interrupted]).catch(() => {});
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    pdfWorker?.destroy();
    worker?.terminate();
  }
}
