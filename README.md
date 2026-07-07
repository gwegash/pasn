# psbs
### A pitch shifting [AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode) built with [Rubber Band](https://breakfastquay.com/rubberband/)

This _should_ be a drop in replacement of [AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode) with a few new [AudioParam](https://developer.mozilla.org/en-US/docs/Web/API/AudioParam)

- `transpose` — pitch in semitones, independent of speed
- `detune` — pitch in cents, also independent of speed
- `loopFade` — crossfade across the loop seam, in seconds

`playbackRate` changes speed only. `start(when, offset, duration)`, `stop(when)`
and the `ended` event work as usual.


## Usage

```javascript
import { PitchShiftBufferSource } from "pitch-shift-buffer-source"

const ctx = new AudioContext();
await PitchShiftBufferSource.init(ctx);

// then construct synchronously, just like AudioBufferSourceNode
const source = new PitchShiftBufferSource(ctx);

const buf = await ctx.decodeAudioData(await (await fetch('audio.wav')).arrayBuffer());
source.buffer = buf;
source.transpose.value = 4;   // up a major third, speed unchanged

source.connect(ctx.destination);
source.start();
```

Pick the Rubber Band algorithm at construction time:

```javascript
const source = new PitchShiftBufferSource(ctx, { engine: 'finer', formant: 'preserved' });
```

Options (each fixed at construction): `engine`, `formant`, `pitchMode`,
`transients`, `detector`, `phase`, `window`, `smoothing`, `channels`.

The defaults work well enough for me.

## Build

Needs the [Emscripten SDK](https://emscripten.org/docs/tools_reference/emsdk.html)

```bash
npm run build
```

## License

GPL-2.0-or-later as per rubberband. See [LICENSE](LICENSE).
