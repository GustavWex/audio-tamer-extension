// Real-time version of the offline "tame" + "despike" + leveler steps.
// The audio is delayed by a 15 ms lookahead so gain reduction starts *before* a loud word or crackle.
//
// Per sample:
//   - 30 ms RMS envelope of the (undelayed) input
//   - running "typical speech level" (slow average of active-speech level)
//   - excess = how far the envelope is above typical-2 dB
//   - level gain  = -excess * over   (over > 1 -> loud parts end up quieter than normal speech)
//   - darkening   = blend toward a 3 kHz low-passed copy, proportional to excess (hides clipping grit)
//   - spike gain  = keeps instantaneous peaks within +10 dB of the 30 ms RMS (crackles / clicks)
//   - auto gain   = slowly brings typical speech to about -20 dBFS
//   - soft clip ceiling at -3 dBFS

const dbToLin = (db) => Math.pow(10, db / 20);
const coef = (seconds, fs) => 1 - Math.exp(-1 / Math.max(1, seconds * fs));

class HeldTracker {
  // Follows a target (in dB or linear) downward quickly, holds, then releases slowly.
  constructor(start, attack, release, holdSamples) {
    this.g = start; this.held = start; this.hold = 0;
    this.aAtt = attack; this.aRel = release; this.H = holdSamples;
  }
  step(tgt) {
    if (tgt <= this.held) { this.held = tgt; this.hold = this.H; }
    else if (this.hold > 0) this.hold--;
    else this.held = tgt;
    this.g += (this.held < this.g ? this.aAtt : this.aRel) * (this.held - this.g);
    return this.g;
  }
}

class Biquad {
  constructor(b0, b1, b2, a1, a2) { Object.assign(this, { b0, b1, b2, a1, a2 }); this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  static lowpass(f, fs, q = Math.SQRT1_2) {
    const w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class TamerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this.over = 1.6;
    this.autoGain = true;
    this.target = -20;            // dBFS for typical speech
    this.L = Math.round(0.015 * fs);
    this.buf = [new Float32Array(this.L), new Float32Array(this.L)];
    this.idx = 0;
    this.aEnv = coef(0.03, fs);
    this.aTyp = coef(4, fs);
    this.aTypFast = coef(0.5, fs);
    this.warmup = 3 * fs;
    this.activeCount = 0;
    this.envOut2 = 1e-6;
    this.typOut = -24;
    this.activeOut = 0;
    this.aMk = coef(1, fs);
    this.env2 = 1e-6;
    this.typ = -22;            // sensible starting guess for web audio speech level
    this.mk = this.target - this.typOut;
    this.level = new HeldTracker(0, coef(this.L / 4 / fs, fs), coef(0.08, fs), this.L + Math.round(0.01 * fs));
    this.dark = new HeldTracker(0, coef(this.L / 4 / fs, fs), coef(0.08, fs), this.L + Math.round(0.01 * fs));
    this.spike = new HeldTracker(0, coef(0.0003, fs), coef(0.002, fs), this.L + Math.round(0.0015 * fs));
    // 4th-order 3 kHz lowpass (two cascaded 2nd-order) per channel for darkening
    this.lp = [0, 1].map(() => [Biquad.lowpass(2500, fs), Biquad.lowpass(2500, fs)]);
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.over === 'number') this.over = d.over;
      if (typeof d.autoGain === 'boolean') this.autoGain = d.autoGain;
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const chIn = [inp[0] || null, inp[1] || inp[0] || null];
    for (let i = 0; i < n; i++) {
      const x0 = chIn[0] ? chIn[0][i] : 0;
      const x1 = chIn[1] ? chIn[1][i] : 0;
      const xm = 0.5 * (x0 + x1);

      // detector (sees audio L samples before it is played)
      this.env2 += this.aEnv * (xm * xm - this.env2);
      const envDb = 10 * Math.log10(this.env2 + 1e-12);
      if (envDb > -55 && envDb > this.typ - 20) {
        // settle quickly during the first ~3 s of speech, then track slowly
        const a = this.activeCount < this.warmup ? this.aTypFast : this.aTyp;
        this.typ += a * (envDb - this.typ);
        this.activeCount++;
      }
      const excess = Math.max(0, envDb - (this.typ - 2));
      const gLevelDb = this.level.step(Math.max(-24, -excess * this.over));
      const k = this.dark.step(-Math.min(1, excess / 4)) * -1; // tracker works "downward", so negate
      const pk = Math.max(Math.abs(x0), Math.abs(x1));
      const lim = Math.sqrt(this.env2) * 3.1623; // +10 dB over 30 ms RMS
      const gSpikeDb = this.spike.step(pk > lim && pk > 1e-4 ? 20 * Math.log10(lim / pk) : 0);
      const gPre = dbToLin(gLevelDb + gSpikeDb);
      // auto gain measures the *tamed* level (before makeup), so it compensates for the taming itself
      const ym = xm * gPre;
      this.envOut2 += this.aEnv * (ym * ym - this.envOut2);
      const outDb = 10 * Math.log10(this.envOut2 + 1e-12);
      if (outDb > -65 && outDb > this.typOut - 20) {
        const a = this.activeOut < this.warmup ? this.aTypFast : this.aTyp;
        this.typOut += a * (outDb - this.typOut);
        this.activeOut++;
      }
      const want = this.autoGain ? Math.min(18, Math.max(-6, this.target - this.typOut)) : 0;
      this.mk += this.aMk * (want - this.mk);
      const g = gPre * dbToLin(this.mk);

      // delayed audio
      const d0 = this.buf[0][this.idx], d1 = this.buf[1][this.idx];
      this.buf[0][this.idx] = x0; this.buf[1][this.idx] = x1;
      this.idx = (this.idx + 1) % this.L;
      const l0 = this.lp[0][1].run(this.lp[0][0].run(d0));
      const l1 = this.lp[1][1].run(this.lp[1][0].run(d1));
      let y0 = (d0 * (1 - k) + l0 * k) * g;
      let y1 = (d1 * (1 - k) + l1 * k) * g;
      const c = 0.708; // -3 dBFS soft ceiling
      y0 = c * Math.tanh(y0 / c);
      y1 = c * Math.tanh(y1 / c);
      out[0][i] = y0;
      if (out[1]) out[1][i] = y1;
    }
    return true;
  }
}

registerProcessor('tamer', TamerProcessor);
