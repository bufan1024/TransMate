import { MAX_TEXT_LENGTH } from './translator.js';

export const MAX_LONG_TEXT_LENGTH = 30_000;

function splitPoint(text) {
  let end = MAX_TEXT_LENGTH;
  const left = text.charCodeAt(end - 1);
  const right = text.charCodeAt(end);
  if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) end -= 1;

  const prefix = text.slice(0, end);
  // Prefer a paragraph boundary. Within one long paragraph, use nearby line,
  // sentence, or word boundaries without turning it into tiny requests.
  const paragraphEnds = [...prefix.matchAll(/(?:\r?\n)[^\S\r\n]*(?:\r?\n)+/g)];
  if (paragraphEnds.length) {
    const last = paragraphEnds.at(-1);
    return last.index + last[0].length;
  }
  for (const pattern of [/[\r\n]+/g, /[.!?。！？；;]/g, /\s+/g]) {
    const last = [...prefix.matchAll(pattern)].at(-1);
    if (last && last.index >= end * 0.7) return last.index + last[0].length;
  }
  return end;
}

export function splitLongText(text) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > MAX_TEXT_LENGTH) {
    const end = splitPoint(remaining);
    const before = remaining.slice(0, end);
    const after = remaining.slice(end);
    const chunk = before.trimEnd();
    remaining = after.trimStart();
    chunks.push({
      text: chunk,
      separator: before.slice(chunk.length) + after.slice(0, after.length - remaining.length),
    });
  }
  if (remaining) chunks.push({ text: remaining, separator: '' });
  return chunks;
}
