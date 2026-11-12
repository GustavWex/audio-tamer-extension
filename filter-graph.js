// Shared Web Audio filter chain (used by the extension and by the offline test page).
// Signal flow:
//   input -> "tamer" worklet (detector-driven dynamic EQ + leveler + volume + soft ceiling) -> output
// All tone changes are dynamic: clean audio passes through, and only scratchy, clipped, thumpy or
// too-loud moments are corrected. See tamer-worklet.js.

export const PRESETS = {
  light: { label: 'Light' },
  standard: { label: 'Standard' },
  smoothest: { label: 'Smoothest' },
};

export const DEFAULT_SETTINGS = { preset: 'standard', volume: 1.0, autoGain: true, bypass: false };

const loadedContexts = new WeakSet();

export async function ensureWorklet(ctx) {
  if (loadedContexts.has(ctx)) return;
  await ctx.audioWorklet.addModule(new URL('./tamer-worklet.js', import.meta.url));
  loadedContexts.add(ctx);
}

const workletSettings = (s) => ({
  preset: PRESETS[s.preset] ? s.preset : DEFAULT_SETTINGS.preset,
  autoGain: s.autoGain !== false,
  volume: typeof s.volume === 'number' ? s.volume : 1,
});

// Builds the chain. Returns { input, output, apply(settings), disconnect() }.
// Call ensureWorklet(ctx) first.
export function buildChain(ctx, settings = DEFAULT_SETTINGS) {
  const s0 = { ...DEFAULT_SETTINGS, ...settings };
  const input = ctx.createGain();
  const output = ctx.createGain();

  const tamer = new AudioWorkletNode(ctx, 'tamer', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    // passed at construction so the very first samples already use the right settings
    processorOptions: { ...workletSettings(s0), debug: s0.debug || 0, params: s0.params },
  });
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  // bypass keeps the same 15 ms delay as the filter, so switching is seamless
  const dryDelay = ctx.createDelay(0.1);
  dryDelay.delayTime.value = 0.015;

  input.connect(tamer).connect(wet).connect(output);
  input.connect(dryDelay).connect(dry).connect(output);

  function apply(s) {
    tamer.port.postMessage(workletSettings(s));
    const t = ctx.currentTime;
    wet.gain.setTargetAtTime(s.bypass ? 0 : 1, t, 0.02);
    dry.gain.setTargetAtTime(s.bypass ? 1 : 0, t, 0.02);
  }

  apply(s0);

  return {
    input,
    output,
    tamer,
    apply: (s) => apply({ ...DEFAULT_SETTINGS, ...s }),
    disconnect() {
      [input, tamer, wet, dryDelay, dry].forEach((n) => n.disconnect());
    },
  };
}
