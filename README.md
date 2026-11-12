# Audio Tamer (Chrome extension)

Live cleanup filter for harsh, clipped, scratchy audio in any Chrome tab. It turns down loud parts, removes bass thumps and crackles, and softens scratchy treble.

## Background

I built this for watching DTU lecture recordings on Panopto. In some lectures, the lecturer holds the
microphone right up against their mouth or throat. The recording overloads every time they speak up,
so the audio clips and turns harsh, scratchy and spiky, which hurts to listen to on headphones.

The filter was tuned on one of those recordings. Analysis showed four problems:
- digital clipping on almost every loud word
- harsh distortion in the 2–5 kHz range
- bass thumps from the mic being so close
- loud words jumping 15+ dB above normal speech

Audio Tamer fixes those live, in any tab. It works on any site, not just Panopto.

*Not affiliated with DTU or Panopto.*

## What it does

Audio Tamer runs two versions of the audio side by side:
- **Dry**: the original, with only a gentle bass-thump cut that switches on during thumps.
- **Cleanup**: a full cleanup chain with bass removal, strong cuts on the scratchy treble and a treble roll-off.
  The loudest moments also get extra darkening.

Detectors decide, word by word, which one you hear. Clipped, scratchy or too-loud words get the
full cleanup, and clean speech stays dry. Audio Tamer looks 15 ms ahead, so it switches just
before the problem reaches your ears.

**Detectors**
- **Loudness**: compares the current level with a robust estimate of your normal speech level.
  The estimate ignores pauses and loud bursts.
- **Brightness**: compares 2–6 kHz with 300–1500 Hz against the normal balance of the voice.
  Only moments at full voice level count, so normal "s" and "t" sounds are left alone.
- **Clipping**: samples near full scale.
- **Bass thumps**: energy below 150 Hz dominating the signal.
- **Crackles**: instant peaks far above the 30 ms level.

**What happens when a detector is active**
1. **Switch to the cleanup chain.** The switch is fast and holds through the word. Both chains
   run all the time, so switching never clicks.
2. **Bass-thump cut** around 110 Hz.
3. **Loud-part taming:** words above normal level are turned down, so shouted, clipped words don't jump out.
4. **Crackle and click suppression.**
5. **Auto gain** toward a steady listening level, with a soft ceiling at −3 dBFS.

Presets: **Light** (gentlest), **Standard** (recommended), **Smoothest** (strongest, for badly clipped audio).
Measured on the lecture recording the filter was tuned on (Standard preset):

| | v1.0 | v1.1 | v1.2 |
|---|---|---|---|
| Treble change on clean speech far from problems | about −23 dB | about −1 dB | about −0.6 dB |
| Clipped words: tone difference from the v10 reference (lower = closer) | – | 8.2 dB | 3.4 dB |
| Loud parts, level vs clean speech | +11.6 dB | +1.7 dB | +4.1 dB |

v1.1 scored well on the numbers but still sounded scratchy on the clipped peaks. v1.2 uses the
full cleanup chain on those moments instead.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `audio-tamer-extension` folder.
4. Optional: pin it with the puzzle-piece icon in the toolbar.

Chrome runs the extension from this folder, so don't delete or move it while it's installed.

## Use

1. Go to the tab that's playing audio.
2. Click the Audio Tamer icon, then **Turn on for this tab**. The icon shows a green "ON" badge.
3. Pick a strength and volume. Tick **Bypass** to compare with the original.
4. Click **Turn off for this tab** to stop. Closing the tab also stops it.

Notes:
- Works on normal web pages (http/https/file). Chrome blocks capture on `chrome://` pages and the Web Store.
- Adds about 15 ms of delay to the tab's audio (look-ahead), which isn't noticeable for video.
  Bypass keeps the same delay, so switching is seamless.
- For the first ~2 s after you turn it on, it's still learning the normal speech level.
- A tab can only be captured by one extension at a time.

## License

MIT, see [LICENSE](LICENSE).
