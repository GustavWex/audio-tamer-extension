import { DEFAULT_SETTINGS } from './filter-graph.js';

const $ = (id) => document.getElementById(id);
const toggleBtn = $('toggle');
const errEl = $('error');
let tab = null;
let active = false;
let settings = { ...DEFAULT_SETTINGS };

const bg = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'background' });

function showError(text) {
  errEl.textContent = text || '';
  errEl.hidden = !text;
}

function render() {
  toggleBtn.textContent = active ? 'Turn off for this tab' : 'Turn on for this tab';
  toggleBtn.classList.toggle('on', active);
  document.querySelectorAll('input[name="preset"]').forEach((r) => { r.checked = r.value === settings.preset; });
  $('volume').value = settings.volume;
  $('volval').textContent = `${Math.round(settings.volume * 100)}%`;
  $('autogain').checked = !!settings.autoGain;
  $('bypass').checked = !!settings.bypass;
}

async function saveAndPush() {
  await chrome.storage.local.set({ settings });
  render();
  if (active) await bg({ type: 'update', tabId: tab.id, settings });
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  $('tab').textContent = tab?.title || 'This tab';
  if (!tab || !/^https?:|^file:/.test(tab.url || '')) {
    toggleBtn.disabled = true;
    showError("Chrome doesn't allow capturing audio from this kind of page.");
  }
  const st = await bg({ type: 'status', tabId: tab.id });
  active = !!st?.active;
  render();
}

toggleBtn.addEventListener('click', async () => {
  showError('');
  toggleBtn.disabled = true;
  try {
    if (active) {
      await bg({ type: 'stop', tabId: tab.id });
      active = false;
    } else {
      // Must be called from the popup click (user gesture). No consumerTabId:
      // the stream is consumed by this extension's offscreen document.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const res = await bg({ type: 'start', tabId: tab.id, streamId, settings });
      if (!res?.ok) throw new Error(res?.error || 'Could not start');
      active = true;
    }
  } catch (e) {
    const m = String(e?.message || e);
    showError(/active stream|already/i.test(m)
      ? 'This tab is already being captured (maybe by another extension). Close and reopen the tab, then try again.'
      : m);
  } finally {
    toggleBtn.disabled = false;
    render();
  }
});

document.querySelectorAll('input[name="preset"]').forEach((r) =>
  r.addEventListener('change', () => { settings.preset = r.value; saveAndPush(); }));
$('volume').addEventListener('input', (e) => { settings.volume = Number(e.target.value); saveAndPush(); });
$('autogain').addEventListener('change', (e) => { settings.autoGain = e.target.checked; saveAndPush(); });
$('bypass').addEventListener('change', (e) => { settings.bypass = e.target.checked; saveAndPush(); });

init();
