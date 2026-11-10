// Service worker: routes popup requests to the offscreen document (where the audio actually runs)
// and keeps track of which tabs are being filtered (for the badge and the popup state).

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Process captured tab audio with the Audio Tamer filter.',
  });
}

async function getActive() {
  const { active = {} } = await chrome.storage.session.get('active');
  return active;
}

async function setActive(tabId, on) {
  const active = await getActive();
  if (on) active[tabId] = true; else delete active[tabId];
  await chrome.storage.session.set({ active });
  try {
    await chrome.action.setBadgeText({ tabId: Number(tabId), text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId: Number(tabId), color: '#2e7d32' });
  } catch (_) { /* tab may be gone */ }
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

async function handle(msg) {
  switch (msg.type) {
    case 'status': {
      const active = await getActive();
      return { active: !!active[msg.tabId] };
    }
    case 'start': {
      await ensureOffscreen();
      const res = await toOffscreen({ type: 'start', tabId: msg.tabId, streamId: msg.streamId, settings: msg.settings });
      if (res && res.ok) await setActive(msg.tabId, true);
      return res;
    }
    case 'stop': {
      const active = await getActive();
      if (active[msg.tabId]) {
        await ensureOffscreen();
        await toOffscreen({ type: 'stop', tabId: msg.tabId });
      }
      await setActive(msg.tabId, false);
      return { ok: true };
    }
    case 'update': {
      const active = await getActive();
      if (!active[msg.tabId]) return { ok: true };
      await ensureOffscreen();
      return toOffscreen({ type: 'update', tabId: msg.tabId, settings: msg.settings });
    }
    case 'ended': {
      // offscreen reports that a capture stopped by itself (tab closed / navigated away from capture)
      await setActive(msg.tabId, false);
      return { ok: true };
    }
  }
  return { ok: false, error: 'unknown message' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return false;
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getActive();
  if (!active[tabId]) return;
  try { await toOffscreen({ type: 'stop', tabId }); } catch (_) {}
  await setActive(tabId, false);
});

// The offscreen document is gone after a browser restart, so clear stale state.
chrome.runtime.onStartup.addListener(() => chrome.storage.session.set({ active: {} }));
