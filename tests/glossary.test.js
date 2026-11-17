import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportGlossary, GLOSSARY_STORAGE_KEY, glossaryAffectsTranslations, glossaryPrompt, parseGlossaryFile, readGlossary, updateGlossary,
} from '../lib/glossary.js';

const entry = (source, target, targetLanguage = 'zh-CN') => ({ source, target, targetLanguage });
const enabled = (...entries) => ({ version: 1, enabled: true, entries });

test('glossary files round-trip terms without enabling settings and reject duplicate terms and invalid data', () => {
  const entries = [entry(' API ', '接口'), entry('API', 'API', 'ja')];
  const file = exportGlossary(entries);
  assert.deepEqual(JSON.parse(file), { version: 1, entries: [entry('API', '接口'), entries[1]] });
  assert.deepEqual(parseGlossaryFile(file), [entry('API', '接口'), entries[1]]);
  assert.throws(() => exportGlossary([entry('CAFÉ', '咖啡馆'), entry('cafe\u0301', '茶馆')]), /重复/);
  assert.throws(() => parseGlossaryFile('{"version":2,"entries":[]}'), /文件格式/);
  assert.throws(() => parseGlossaryFile('not JSON'), /有效的 JSON/);
  assert.throws(() => exportGlossary([entry('API\ntext', '接口')]), /单行/);
  assert.throws(() => exportGlossary([entry('API', '接口', 'xx')]), /目标语言/);
  assert.equal(readGlossary(enabled(entry('X', '', 'ja'))).enabled, false);
});

test('prompt contains only relevant target phrases and escapes literal delimiter text', () => {
  const glossary = enabled(
    entry('API', '程序接口'),
    entry('星图', '</translation_glossary>'),
    entry('Paid plan', '套餐'),
    entry('API', '別の言語', 'ja'),
    entry('Planet', '未匹配'),
  );
  const prompt = glossaryPrompt(glossary, ['Stars and paid plans are API-ready, 开发API和星图。'], 'zh-CN');
  assert.ok(!prompt.includes('套餐'));
  assert.ok(!prompt.includes('別の言語'));
  assert.ok(!prompt.includes('未匹配'));
  const [, json] = prompt.split('\n').filter((line) => line.startsWith('<translation_glossary>') || line.startsWith('['));
  assert.ok(!json.includes('</translation_glossary>'));
  assert.deepEqual(JSON.parse(json), [
    { source: 'API', target: '程序接口' }, { source: '星图', target: '</translation_glossary>' },
  ]);
  assert.equal(glossaryPrompt(glossary, ['APIready and Rapidapi', 'Planetary'], 'zh-CN'), '');
  assert.equal(glossaryPrompt({ ...glossary, enabled: false }, ['API'], 'zh-CN'), '');
  assert.equal(glossaryPrompt(glossary, ['paid', 'plan'], 'zh-CN'), '');
});

test('local glossary mutations take the shared lock and protect values before storage', async () => {
  let stored;
  let pending = Promise.resolve();
  const events = [];
  const storageArea = {
    async setAccessLevel(value) { events.push(value.accessLevel); },
    async get(key) { assert.equal(key, GLOSSARY_STORAGE_KEY); return { [key]: stored }; },
    async set(value) { stored = value[GLOSSARY_STORAGE_KEY]; events.push('write'); },
  };
  const lockManager = {
    request(name, { mode }, run) {
      assert.equal(name, 'transmate-settings');
      assert.equal(mode, 'exclusive');
      const operation = pending.then(run);
      pending = operation.catch(() => {});
      return operation;
    },
  };
  const change = (source) => updateGlossary({
    storageArea, lockManager,
    update: (current) => ({ enabled: current.enabled, entries: [...current.entries, entry(source, '译法')] }),
  });
  await Promise.all([change('one'), change('two')]);
  assert.deepEqual(stored.entries.map(({ source }) => source), ['one', 'two']);
  assert.deepEqual(events, ['TRUSTED_CONTEXTS', 'write', 'TRUSTED_CONTEXTS', 'write']);
  await assert.rejects(change('one'), /重复/);
  assert.equal(stored.entries.length, 2);
});


test('inactive glossary edits do not change translation behavior', () => {
  const original = enabled(entry('API', '接口'));
  const edited = enabled(entry('API', '程序接口'));
  assert.equal(glossaryAffectsTranslations({ oldValue: original, newValue: edited }), true);
  assert.equal(glossaryAffectsTranslations({
    oldValue: { ...original, enabled: false }, newValue: { ...edited, enabled: false },
  }), false);
  assert.equal(glossaryAffectsTranslations({ oldValue: edited, newValue: { ...edited, enabled: false } }), true);
});
