// Audio Tamer processor (v1.2): "v10 on the peaks, untouched everywhere else".
//
// Two versions of the audio run side by side:
//   dry  - the original, with only a gentle 60 Hz high-pass and a bass-thump cut that switches
//          on during thumps
//   wet  - a replica of the offline "v10" cleanup chain (bass removal, scratchy-treble cuts and
//          treble roll-off), plus extra darkening on the loudest moments
// Detectors decide, moment by moment, which one you hear. Clipping, words well above normal
// level, or harsh brightness switch to wet for that word; clean speech stays dry. The audio is
// delayed by a 15 ms lookahead, so the switch happens just *before* the problem arrives.
//
// Detectors (on the undelayed input):
//   level     20 ms level vs a robust "normal speech" level (median tracker, ignores pauses)
//   harsh     2-6 kHz vs 300-1500 Hz balance vs that balance in normal speech
//   clip      samples near full scale (clipping damage)
//   thump     energy below 150 Hz dominating the signal
//   spike     instant peaks far above the 30 ms level (crackles / clicks)
// Also: loud-word leveler, crackle suppression, slow auto gain, soft ceiling at -3 dBFS.

const dbToLin = (db) => Math.pow(10, db / 20);
const coef = (seconds, fs) => 1 - Math.exp(-1 / Math.max(1, seconds * fs));

// ---- small DSP helpers -----------------------------------------------------------------
class Biquad {
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; return this; }
  copy(o) { this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2; this.a1 = o.a1; this.a2 = o.a2; return this; }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  // RBJ cookbook designs
  lowpass(f, fs, q = Math.SQRT1_2) { const w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  highpass(f, fs, q = Math.SQRT1_2) { const w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  // 0 dB-peak bandpass: x - k*BP(x) blends exactly between flat (k=0) and a notch (k=1)
  bandpass(f, fs, q) { const w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this.set(al, 0, -al, 1 + al, -2 * c, 1 - al); }
  peaking(f, fs, q, gDb) {
    const A = Math.pow(10, gDb / 40), w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  shelf(type, f, fs, gDb, S = 1) {
    const A = Math.pow(10, gDb / 40), w = 2 * Math.PI * f / fs, c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2), sq = 2 * Math.sqrt(A) * al;
    if (type === 'low') return this.set(A * ((A + 1) - (A - 1) * c + sq), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sq),
      (A + 1) + (A - 1) * c + sq, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sq);
    return this.set(A * ((A + 1) + (A - 1) * c + sq), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sq),
      (A + 1) - (A - 1) * c + sq, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sq);
  }
}

class Tracker {
  // Moves toward a lower target quickly (attack), holds it, then releases slowly.
  constructor(fs, attackS, releaseS, holdS) { this.v = 0; this.held = 0; this.h = 0; this.aA = coef(attackS, fs); this.aR = coef(releaseS, fs); this.H = Math.round(holdS * fs); }
  step(t) { // t is a reduction in dB (<= 0)
    if (t <= this.held) { this.held = t; this.h = this.H; } else if (this.h > 0) this.h--; else this.held = t;
    this.v += (this.held < this.v ? this.aA : this.aR) * (this.held - this.v);
    return this.v;
  }
}

// Wet (cleanup) chains, as [type, frequency, Q, gain dB] biquads. "standard" replicates the v10 file.
const BASE_CHAIN = [['hp', 150, 0.707], ['hp', 150, 0.707], ['hp', 100, 0.707], ['pk', 3000, 1, -5], ['pk', 6500, 1, -8], ['lp', 8000, 0.707], ['lp', 8000, 0.707]];
const V10_CHAIN = [...BASE_CHAIN, ['pk', 2200, 1.25, -4], ['pk', 3000, 1, -3], ['pk', 4000, 1, -6], ['lp', 5000, 0.707], ['lp', 5000, 0.707], ['lp', 5000, 0.707]];
const WET_CHAINS = {
  light: [...BASE_CHAIN, ['pk', 2500, 1, -6], ['pk', 4000, 1, -9], ['lp', 6500, 0.707], ['lp', 6500, 0.707]], // between v9 and v10
  standard: [...V10_CHAIN, ['lp', 4500, 0.707]],                                                             // ~ v10 on the peaks
  smoothest: [...V10_CHAIN, ['pk', 3000, 0.8, -6], ['lp', 4500, 0.707], ['lp', 4500, 0.707]],                 // ~ v10b, darker
};

const PRESET_PARAMS = {
  // mixAt: switch to the cleanup chain when a word is this many dB above normal speech (clipping always switches)
  // dark: extra blend of a 3 kHz low-passed copy on the loudest moments (as in v9/v10)
  // levelStart/over: leveler threshold (dB over normal) and strength | thumpMax: deepest bass-thump cut on the dry path
  // spikeDb: crackle limit (dB over the 30 ms level) | makeup: extra auto gain that makes up for the leveling
  light:     { mixAt: 7, dark: 0.4, levelStart: 3, over: 1.2, thumpMax: 9,  spikeDb: 8, makeup: 0 },
  standard:  { mixAt: 5, dark: 0.8, levelStart: 2, over: 1.6, thumpMax: 12, spikeDb: 7, makeup: 3 },
  smoothest: { mixAt: 3, dark: 1.0, levelStart: 1, over: 2.0, thumpMax: 15, spikeDb: 7, makeup: 4.5 },
};

class TamerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const fs = this.fs = sampleRate;
    const init = (options && options.processorOptions) || {};
    this.override = init.params || {};
    this.preset = PRESET_PARAMS[init.preset] ? init.preset : 'standard';
    this.p = { ...PRESET_PARAMS[this.preset], ...this.override };
    this.autoGain = init.autoGain !== false;
    this.vol = typeof init.volume === 'number' ? init.volume : 1;
    this.debug = init.debug || 0; // test harness only: writes detector values to the output
    this.target = -15; // dBFS (20 ms level) for normal speech when auto gain is on; about -21 dBFS average loudness

    this.L = Math.round(0.015 * fs);
    this.buf = [new Float32Array(this.L), new Float32Array(this.L)];
    this.idx = 0;

    // detector filters (mono)
    this.dHP = new Biquad().highpass(60, fs);
    this.dHi = [new Biquad().highpass(2000, fs), new Biquad().lowpass(6000, fs)];
    this.dMid = [new Biquad().highpass(300, fs), new Biquad().lowpass(1500, fs)];
    this.dLf = [new Biquad().lowpass(150, fs), new Biquad().lowpass(150, fs)];
    this.aEnv = coef(0.02, fs);
    this.aRms = coef(0.03, fs);
    this.eFull = this.eHi = this.eMid = this.eLf = this.eRms = 1e-9;

    // robust trackers (dB)
    this.floor = -70;        // background noise level
    this.typ = -24;          // normal speech level (median tracker)
    this.base = -12;         // normal 2-6k vs 300-1.5k balance in speech (median tracker)
    this.speechSamples = 0;
    this.clipHold = 0;

    this.tMix = new Tracker(fs, 0.003, 0.1, 0.015 + 0.05); // switch to wet fast, hold through the word, ease back
    this.tThump = new Tracker(fs, 0.003, 0.05, 0.015 + 0.005);
    this.tLevel = new Tracker(fs, 0.004, 0.08, 0.015 + 0.01);
    this.tSpike = new Tracker(fs, 0.0003, 0.002, 0.015 + 0.0015);
    this.mk = this.autoGain ? this.target - this.typ + (this.p.makeup || 0) : 0;
    this.aMk = coef(2, fs);

    // audio-path filters per channel
    this.aHP = [0, 1].map(() => new Biquad().highpass(60, fs));
    this.thumpBP = [0, 1].map(() => new Biquad().bandpass(110, fs, 0.7)); // dry: x - k*BP(x) never clicks
    this.darkLP = [0, 1].map(() => [new Biquad().lowpass(3000, fs), new Biquad().lowpass(3000, fs)]);
    this.buildWet(this.preset);

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.preset && PRESET_PARAMS[d.preset]) {
        this.p = { ...PRESET_PARAMS[d.preset], ...this.override };
        if (d.preset !== this.preset) { this.preset = d.preset; this.buildWet(d.preset); }
      }
      if (typeof d.autoGain === 'boolean') this.autoGain = d.autoGain;
      if (typeof d.volume === 'number') this.vol = d.volume;
    };
  }

  mixOut(ch, d, kT, mix, kD) {
    const x = this.aHP[ch].run(d);
    const dry = x - kT * this.thumpBP[ch].run(x);
    let wet = this.wetRun(ch, d); // filters always run, so switching never clicks
    const lp = this.darkLP[ch][1].run(this.darkLP[ch][0].run(wet));
    wet += kD * (lp - wet);
    return dry + mix * (wet - dry);
  }

  buildWet(name) {
    const spec = WET_CHAINS[name] || WET_CHAINS.standard, fs = this.fs;
    this.wet = [0, 1].map(() => spec.map(([t, f, q, g]) =>
      t === 'hp' ? new Biquad().highpass(f, fs, q) : t === 'lp' ? new Biquad().lowpass(f, fs, q) : new Biquad().peaking(f, fs, q, g)));
  }

  wetRun(ch, x) {
    const w = this.wet[ch];
    for (let k = 0; k < w.length; k++) x = w[k].run(x);
    return x;
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0], n = out[0].length, fs = this.fs, p = this.p;
    const in0 = inp[0] || null, in1 = inp[1] || inp[0] || null;
    const upFloor = 3 / fs, downFloor = coef(0.05, fs);
    for (let i = 0; i < n; i++) {
      const x0 = in0 ? in0[i] : 0, x1 = in1 ? in1[i] : 0;

      // ---------- detectors ----------
      const xm = this.dHP.run(0.5 * (x0 + x1));
      const hi = this.dHi[1].run(this.dHi[0].run(xm));
      const mid = this.dMid[1].run(this.dMid[0].run(xm));
      const lf = this.dLf[1].run(this.dLf[0].run(xm));
      const a = this.aEnv;
      this.eFull += a * (xm * xm - this.eFull);
      this.eHi += a * (hi * hi - this.eHi);
      this.eMid += a * (mid * mid - this.eMid);
      this.eLf += a * (lf * lf - this.eLf);
      this.eRms += this.aRms * (xm * xm - this.eRms);
      const lvl = 10 * Math.log10(this.eFull + 1e-12);

      // background floor: falls fast, rises slowly (3 dB/s)
      if (lvl < this.floor) this.floor += downFloor * (lvl - this.floor); else this.floor += upFloor;
      // "speech" = clearly above the background AND not far below normal speech
      // (so pauses, breaths and room noise never drag the normal level down)
      const speech = lvl > this.floor + 15 && lvl > this.typ - 12 && lvl > -65;
      if (speech) {
        // median trackers: step a fixed amount toward the input, so loud bursts barely move them
        const warm = this.speechSamples < 2 * fs;
        const st = (warm ? 20 : 3) / fs;
        this.typ += lvl > this.typ ? st : -st;
        const ratio = 10 * Math.log10((this.eHi + 1e-12) / (this.eMid + 1e-12));
        if (lvl < this.typ + 3) this.base += (ratio > this.base ? 1 : -1) * (warm ? 10 : 2) / fs;
        this.speechSamples++;
      }
      const ratioNow = 10 * Math.log10((this.eHi + 1e-12) / (this.eMid + 1e-12));
      // Only bright moments at (or above) normal voice level count as scratchy. Normal "s"/"t"
      // sounds are bright too, but they're much quieter than vowels, so they are left alone.
      const harshEx = speech && lvl > this.typ - 2 ? Math.max(0, ratioNow - this.base - 3) : 0;
      const loudEx = Math.max(0, lvl - (this.typ + 5));
      const levelEx = Math.max(0, lvl - (this.typ + p.levelStart));
      const pk = Math.max(Math.abs(x0), Math.abs(x1));
      if (pk >= 0.89) this.clipHold = Math.round(0.06 * fs); else if (this.clipHold > 0) this.clipHold--;

      // switch to the cleanup chain on clipping, loud words or harsh brightness
      const trigger = this.clipHold > 0 || (speech && lvl > this.typ + p.mixAt) || harshEx > 3;
      const mix = -this.tMix.step(trigger ? -1 : 0); // 0 = dry, 1 = wet
      const kD = p.dark * mix * Math.min(1, Math.max(0, lvl - this.typ) / 6);

      const lfShare = 10 * Math.log10((this.eLf + 1e-12) / (this.eFull + 1e-12));
      const thumpT = speech || lvl > this.typ - 10 ? -Math.min(p.thumpMax, Math.max(0, lfShare + 4) * 3) : 0;
      const thumpDb = this.tThump.step(thumpT);

      const levelDb = this.tLevel.step(-Math.min(20, levelEx * p.over));
      const lim = Math.sqrt(this.eRms) * dbToLin(p.spikeDb); // peaks allowed this far over the 30 ms level
      const spikeDb = this.tSpike.step(pk > lim && pk > 1e-4 ? 20 * Math.log10(lim / pk) : 0);

      const want = this.autoGain ? Math.min(18, Math.max(-6, this.target - this.typ)) + (p.makeup || 0) : 0;
      this.mk += this.aMk * (want - this.mk);

      const kT = 1 - dbToLin(thumpDb);

      // ---------- delayed audio path ----------
      const d0 = this.buf[0][this.idx], d1 = this.buf[1][this.idx];
      this.buf[0][this.idx] = x0; this.buf[1][this.idx] = x1;
      this.idx = (this.idx + 1) % this.L;
      const g = dbToLin(levelDb + spikeDb + this.mk) * this.vol; // volume applied before the soft ceiling
      let y0 = this.mixOut(0, d0, kT, mix, kD) * g;
      let y1 = this.mixOut(1, d1, kT, mix, kD) * g;
      const c = 0.708; // -3 dBFS soft ceiling
      y0 = c * Math.tanh(y0 / c);
      y1 = c * Math.tanh(y1 / c);
      if (this.debug) {
        const dv = this.debug === 1 ? [mix * -10, levelDb] : this.debug === 2 ? [this.typ, this.base] : this.debug === 3 ? [lvl, ratioNow] : this.debug === 4 ? [thumpDb, this.floor] : [spikeDb, 20 * Math.log10(lim + 1e-9)];
        y0 = dv[0] / 100; y1 = dv[1] / 100;
      }
      out[0][i] = y0;
      if (out[1]) out[1][i] = y1;
    }
    return true;
  }
}

registerProcessor('tamer', TamerProcessor);
