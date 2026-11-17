import assert from 'node:assert/strict';
import test from 'node:test';
import { splitLongText } from '../lib/long-translation.js';

test('long text keeps paragraph boundaries, their spacing, and source order', () => {
  const first = '甲'.repeat(4100);
  const second = '乙'.repeat(3000);
  const third = '丙'.repeat(2750);
  const text = first + '\r\n  \r\n' + second + '\n\n' + third;
  const chunks = splitLongText(text);
  assert.deepEqual(chunks.map(({ text }) => text), [first, second, third]);
  assert.equal(chunks.map(({ text, separator }) => text + separator).join(''), text);
  assert.ok(chunks.every(({ text }) => text.length <= 5000));
});

test('an unavoidable boundary never breaks a surrogate pair', () => {
  const text = 'a'.repeat(4999) + '🌦️' + 'b'.repeat(5250);
  const chunks = splitLongText(text);
  assert.equal(chunks[0].text.length, 4999);
  assert.ok(chunks[1].text.startsWith('🌦️'));
  assert.ok(chunks.every(({ text }) => text.length <= 5000));
  assert.equal(chunks.map(({ text, separator }) => text + separator).join(''), text);
});
