import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearHistory, deleteHistoryEntry, HISTORY_KEY, recordTranslation, setHistoryEnabled,
} from '../lib/translation-history.js';

function makeStorage() {
  const data = {};
  let previous = Promise.resolve();
  const storage = {
    get: async () => structuredClone(data),
    set: async (values) => Object.assign(data, structuredClone(values)),
  };
  const locks = {
    request(_name, work) {
      const result = previous.then(work);
      previous = result.catch(() => {});
      return result;
    },
  };
  return { data, storage, locks };
}

test('history records no text until explicitly enabled', async () => {
  const { data, storage, locks } = makeStorage();
  const entry = { source: 'Private source', translation: '译文', targetLanguage: 'zh-CN' };
  await recordTranslation(storage, locks, entry);
  assert.equal(data[HISTORY_KEY], undefined);

  await setHistoryEnabled(storage, locks, true);
  await recordTranslation(storage, locks, entry);
  await setHistoryEnabled(storage, locks, false);
  await recordTranslation(storage, locks, { ...entry, source: 'Unrecorded' });
  assert.deepEqual(data[HISTORY_KEY].entries.map(({ source }) => source), ['Private source']);
});

test('history supports concurrent recording, individual removal and clear', async () => {
  const { data, storage, locks } = makeStorage();
  await setHistoryEnabled(storage, locks, true);
  await Promise.all(['first', 'second'].map((source) => recordTranslation(storage, locks, {
    source, translation: '译文', targetLanguage: 'zh-CN',
  })));
  assert.deepEqual(data[HISTORY_KEY].entries.map(({ source }) => source), ['second', 'first']);
  const [latest] = data[HISTORY_KEY].entries;
  await deleteHistoryEntry(storage, locks, latest.id);
  assert.equal(data[HISTORY_KEY].entries.length, 1);
  await clearHistory(storage, locks);
  assert.deepEqual(data[HISTORY_KEY], { enabled: true, entries: [] });
});
