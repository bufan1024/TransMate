import { DEFAULT_SETTINGS, TARGET_LANGUAGES } from './config.js';
import {
  GLOSSARY_STORAGE_KEY, MAX_GLOSSARY_FILE_BYTES,
  exportGlossary, glossaryEntryKey, parseGlossaryFile, readGlossary, updateGlossary,
} from './glossary.js';

export function createGlossaryEditor(root, chromeApi, lockManager) {
  const form = root.querySelector('#glossary-form');
  const enabled = form.querySelector('#glossary-enabled');
  const source = form.querySelector('#glossary-source');
  const target = form.querySelector('#glossary-target');
  const language = form.querySelector('#glossary-language');
  const save = form.querySelector('#glossary-save');
  const cancel = form.querySelector('#glossary-cancel');
  const importButton = form.querySelector('#glossary-import');
  const exportButton = form.querySelector('#glossary-export');
  const clear = form.querySelector('#glossary-clear');
  const file = form.querySelector('#glossary-file');
  const list = form.querySelector('#glossary-list');
  const status = form.querySelector('#glossary-status');
  const storageArea = chromeApi.storage.local;
  let glossary = readGlossary();
  let editing = null;
  let ready = false;
  let busy = false;
  let revision = 0;

  for (const { id, name } of TARGET_LANGUAGES) {
    const option = root.createElement('option');
    option.value = id;
    option.textContent = name;
    language.append(option);
  }
  language.value = DEFAULT_SETTINGS.targetLanguage;

  function report(message, tone) {
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = false;
  }

  function syncControls() {
    const disabled = busy || !ready;
    for (const control of [enabled, source, target, language, save, cancel, importButton, exportButton, file]) {
      control.disabled = disabled;
    }
    clear.disabled = disabled || !glossary.entries.length;
    for (const button of list.querySelectorAll('button')) button.disabled = disabled;
  }

  function setEditing(entry) {
    editing = entry;
    source.value = entry?.source || '';
    target.value = entry?.target || '';
    if (entry) language.value = entry.targetLanguage;
    cancel.hidden = !entry;
    save.textContent = entry ? '保存术语' : '添加术语';
  }

  function action(label, description, run) {
    const button = root.createElement('button');
    button.type = 'button';
    button.className = 'permission-revoke';
    button.textContent = label;
    button.setAttribute('aria-label', label + ' ' + description);
    button.addEventListener('click', run);
    return button;
  }

  function render() {
    enabled.checked = glossary.enabled;
    list.replaceChildren();
    if (!glossary.entries.length) {
      const empty = root.createElement('li');
      empty.className = 'permission-empty';
      empty.textContent = '还没有固定术语。';
      list.append(empty);
    }
    for (const entry of glossary.entries) {
      const item = root.createElement('li');
      const text = root.createElement('div');
      const pair = root.createElement('span');
      pair.textContent = entry.source + ' → ' + entry.target;
      const scope = root.createElement('small');
      scope.textContent = TARGET_LANGUAGES.find(({ id }) => id === entry.targetLanguage).name;
      text.append(pair, scope);
      const buttons = root.createElement('div');
      buttons.className = 'glossary-row-actions';
      const description = entry.source + '（' + scope.textContent + '）';
      buttons.append(action('编辑', description, () => {
        setEditing(entry);
        source.focus();
      }), action('删除', description, () => {
        const key = glossaryEntryKey(entry);
        void change((current) => {
          const latest = current.entries.find((term) => glossaryEntryKey(term) === key);
          if (!latest || latest.target !== entry.target) throw new Error('这条术语已在另一个设置页更改，请重新选择删除。');
          return { ...current, entries: current.entries.filter((term) => glossaryEntryKey(term) !== key) };
        }, '术语已删除。', editing && glossaryEntryKey(editing) === key);
      }));
      item.append(text, buttons);
      list.append(item);
    }
    syncControls();
  }

  async function change(update, message, resetEditor = false) {
    if (!ready || busy) return;
    busy = true;
    syncControls();
    try {
      const startedAt = revision;
      const saved = await updateGlossary({ storageArea, lockManager, update });
      if (revision === startedAt) glossary = saved;
      if (resetEditor) setEditing(null);
      report(message, 'success');
    } catch (error) {
      report(error?.message || '无法更新术语库，请重试。', 'error');
    } finally {
      busy = false;
      render();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const entry = { source: source.value, target: target.value, targetLanguage: language.value };
    const previous = editing;
    void change((current) => {
      if (!previous) return { ...current, entries: [...current.entries, entry] };
      const key = glossaryEntryKey(previous);
      const index = current.entries.findIndex((term) => glossaryEntryKey(term) === key);
      if (index < 0 || current.entries[index].target !== previous.target) {
        throw new Error('这条术语已在另一个设置页更改，请重新选择编辑。');
      }
      return { ...current, entries: current.entries.with(index, entry) };
    }, previous ? '术语已保存。' : '术语已添加。', true);
  });

  enabled.addEventListener('change', () => {
    const checked = enabled.checked;
    void change((current) => ({ ...current, enabled: checked }),
      checked ? '已启用术语库。' : '已停用术语库。');
  });
  cancel.addEventListener('click', () => setEditing(null));
  clear.addEventListener('click', () => {
    if (!window.confirm('确定清空本机术语库中的全部术语吗？')) return;
    void change((current) => ({ ...current, entries: [] }), '术语库已清空。', true);
  });
  importButton.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const selected = file.files[0];
    file.value = '';
    if (!selected) return;
    try {
      if (selected.size > MAX_GLOSSARY_FILE_BYTES) throw new Error('术语文件过大。');
      const entries = parseGlossaryFile(await selected.text());
      if (!window.confirm('导入 ' + entries.length + ' 条术语并替换本机现有术语？')) return;
      await change((current) => ({ ...current, entries }), '术语已导入。', true);
    } catch (error) {
      report(error?.message || '无法读取术语文件。', 'error');
    }
  });
  exportButton.addEventListener('click', () => {
    const blob = new Blob([exportGlossary(glossary.entries)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = root.createElement('a');
    link.href = url;
    link.download = 'transmate-glossary.json';
    root.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[GLOSSARY_STORAGE_KEY]) return;
    revision += 1;
    glossary = readGlossary(changes[GLOSSARY_STORAGE_KEY].newValue);
    render();
  });

  syncControls();
  return {
    async initialize() {
      try {
        const startedAt = revision;
        const stored = await storageArea.get(GLOSSARY_STORAGE_KEY);
        if (revision === startedAt) glossary = readGlossary(stored[GLOSSARY_STORAGE_KEY]);
        ready = true;
        render();
      } catch {
        report('无法读取本机术语库，请重新打开设置页。', 'error');
      }
    },
  };
}
