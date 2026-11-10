// Offscreen document: captures each selected tab's audio, runs it through the filter chain
// and plays the result. (Capturing a tab mutes its normal output, so we must play it back here.)
import { buildChain, ensureWorklet } from './filter-graph.js';

let ctx = null;
const sessions = new Map(); // tabId -> { stream, source, chain }

async function getContext() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume();
  await ensureWorklet(ctx);
  return ctx;
}

function stop(tabId, notify = false) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  try { s.source.disconnect(); } catch (_) {}
  try { s.chain.disconnect(); } catch (_) {}
  s.stream.getTracks().forEach((t) => t.stop());
  if (notify) chrome.runtime.sendMessage({ target: 'background', type: 'ended', tabId });
}

async function start(tabId, streamId, settings) {
  if (sessions.has(tabId)) stop(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: false,
  });
  const c = await getContext();
  const source = c.createMediaStreamSource(stream);
  const chain = buildChain(c, settings);
  source.connect(chain.input);
  chain.output.connect(c.destination);
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => stop(tabId, true)));
  sessions.set(tabId, { stream, source, chain });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'start':
        await start(msg.tabId, msg.streamId, msg.settings);
        return { ok: true };
      case 'stop':
        stop(msg.tabId);
        return { ok: true };
      case 'update': {
        const s = sessions.get(msg.tabId);
        if (s) s.chain.apply(msg.settings);
        return { ok: true };
      }
    }
    return { ok: false, error: 'unknown message' };
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
