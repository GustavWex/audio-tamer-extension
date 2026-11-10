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

1. **Bass thump removal**: steep high-pass at 150 Hz.
2. **Scratchy-treble cut**: four peaking cuts around 2.2–6.5 kHz plus a low-pass roll-off.
3. **Loud-part taming**: 15 ms look-ahead leveler. Anything above your normal level is
   turned down past normal (×1.6), so shouted, clipped words end up *quieter* than regular speech.
4. **Grit darkening**: blends a 2.5 kHz low-passed copy into the loud moments only.
5. **Crackle/click suppression**: keeps instant peaks within +10 dB of the 30 ms level.
6. **Auto gain**: slowly keeps typical speech around −20 dBFS, with a soft ceiling at −3 dBFS
   and a final safety limiter.

Presets: **Light** (keeps more clarity), **Standard** (recommended), **Smoothest** (for badly clipped audio).

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
- The first ~2 s after turning it on can be a bit quiet while the leveler learns the level.
- A tab can only be captured by one extension at a time.

## License

MIT, see [LICENSE](LICENSE).
