import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PDF_BYTES, readLocalPdf } from '../lib/local-pdf.js';

test('empty and oversized PDFs are rejected before reading any bytes', async () => {
  const arrayBuffer = () => assert.fail('file bytes were read despite the size limit');
  await assert.rejects(readLocalPdf({ size: 0, arrayBuffer }), /文件为空/);
  await assert.rejects(readLocalPdf({ size: MAX_PDF_BYTES + 1, arrayBuffer }), /20 MB/);
});

test('PDF filename and MIME type do not bypass byte inspection', async () => {
  const invalid = new File(['This is plain text'], 'fake.pdf', { type: 'application/pdf' });
  await assert.rejects(readLocalPdf(invalid), /此文件不是 PDF/);
});

test('a cancelled PDF is not read', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readLocalPdf({
    size: 100,
    arrayBuffer: () => assert.fail('cancelled PDF was read'),
  }, { signal: controller.signal }), { name: 'AbortError' });
});
