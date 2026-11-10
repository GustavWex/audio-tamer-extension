// Shared Web Audio filter chain (used by the extension and by the offline test page).
// Signal flow:
//   input -> 3x highpass (bass thumps) -> peaking cuts (scratchy 2-5 kHz) -> lowpass roll-off
//         -> "tamer" worklet (lookahead loud-part taming + darkening + crackle suppression)
//         -> output volume -> safety limiter -> output

export const PRESETS = {
  light: {
    label: 'Light',
    peaks: [{ f: 2500, q: 1, g: -3 }, { f: 4000, q: 1, g: -5 }],
    lowpass: { f: 9000, stages: 2 },
    over: 1.2,
  },
  standard: {
    label: 'Standard',
    peaks: [{ f: 2500, q: 1, g: -7 }, { f: 3200, q: 1, g: -6 }, { f: 4000, q: 1, g: -9 }, { f: 6500, q: 1, g: -8 }],
    lowpass: { f: 6500, stages: 3 },
    over: 1.6,
  },
  smoothest: {
    label: 'Smoothest',
    peaks: [{ f: 2200, q: 1.25, g: -8 }, { f: 3000, q: 1, g: -8 }, { f: 4000, q: 1, g: -12 }, { f: 5500, q: 1, g: -10 }],
    lowpass: { f: 5000, stages: 3 },
    over: 1.6,
  },
};

export const DEFAULT_SETTINGS = { preset: 'standard', volume: 1.0, autoGain: true, bypass: false };

const loadedContexts = new WeakSet();

export async function ensureWorklet(ctx) {
  if (loadedContexts.has(ctx)) return;
  await ctx.audioWorklet.addModule(new URL('./tamer-worklet.js', import.meta.url));
  loadedContexts.add(ctx);
}

function biquad(ctx, type, f, q, g = 0) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.frequency.value = f;
  n.Q.value = q;
  n.gain.value = g;
  return n;
}

// Builds the chain. Returns { input, output, apply(settings), disconnect() }.
// Call ensureWorklet(ctx) first.
export function buildChain(ctx, settings = DEFAULT_SETTINGS) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // Wet path ---------------------------------------------------------------
  const hp = [biquad(ctx, 'highpass', 150, 0.707), biquad(ctx, 'highpass', 150, 0.707), biquad(ctx, 'highpass', 100, 0.707)];
  const peaks = [0, 1, 2, 3].map(() => biquad(ctx, 'peaking', 3000, 1, 0));
  const lps = [0, 1, 2].map(() => biquad(ctx, 'lowpass', 20000, 0.707));
  const tamer = new AudioWorkletNode(ctx, 'tamer', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  const volume = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  const wet = ctx.createGain();
  const dry = ctx.createGain();

  const chain = [input, ...hp, ...peaks, ...lps, tamer, volume, limiter, wet, output];
  for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  input.connect(dry).connect(output);

  function apply(s) {
    const p = PRESETS[s.preset] || PRESETS.standard;
    peaks.forEach((n, i) => {
      const pk = p.peaks[i];
      n.frequency.value = pk ? pk.f : 1000;
      n.Q.value = pk ? pk.q : 1;
      n.gain.value = pk ? pk.g : 0; // 0 dB peaking = transparent
    });
    lps.forEach((n, i) => {
      // unused stages are pushed above the audible range
      n.frequency.value = i < p.lowpass.stages ? p.lowpass.f : Math.min(22000, ctx.sampleRate / 2 - 100);
    });
    tamer.port.postMessage({ over: p.over, autoGain: !!s.autoGain });
    volume.gain.value = s.volume ?? 1;
    const t = ctx.currentTime;
    wet.gain.setTargetAtTime(s.bypass ? 0 : 1, t, 0.02);
    dry.gain.setTargetAtTime(s.bypass ? 1 : 0, t, 0.02);
  }

  apply({ ...DEFAULT_SETTINGS, ...settings });

  return {
    input,
    output,
    tamer,
    apply: (s) => apply({ ...DEFAULT_SETTINGS, ...s }),
    disconnect() {
      chain.forEach((n) => n.disconnect());
      dry.disconnect();
    },
  };
}
