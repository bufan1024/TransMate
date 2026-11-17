import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('English and Chinese catalogs expose the same labels and substitution slots', async () => {
  const [chinese, english, manifest] = await Promise.all([
    readJson('../_locales/zh_CN/messages.json'),
    readJson('../_locales/en/messages.json'),
    readJson('../manifest.json'),
  ]);
  assert.equal(manifest.default_locale, 'zh_CN');
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  for (const [key, definition] of Object.entries(chinese)) {
    assert.ok(definition.message && english[key].message, key);
    assert.deepEqual(english[key].placeholders, definition.placeholders, key);
  }
  for (const [, key] of JSON.stringify(manifest).matchAll(/__MSG_([\da-zA-Z_]+)__/g)) {
    assert.ok(chinese[key]?.message && english[key]?.message, key);
  }
});
