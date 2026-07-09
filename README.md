# timestretcher
### Offline time-stretching & pitch-shifting built with [Rubber Band](https://breakfastquay.com/rubberband/)

Stretch or pitch-shift an [AudioBuffer](https://developer.mozilla.org/en-US/docs/Web/API/AudioBuffer)
offline — in a [Worker](https://developer.mozilla.org/en-US/docs/Web/API/Worker), off the main and
audio threads — and get an `AudioBuffer` back. Play it through a plain
[AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode)

- `timeRatio` — output duration ÷ input duration
- `semitones` — pitch shift

## Usage

```javascript
import { Timestretcher } from "timestretcher"

await Timestretcher.init();   // load the wasm, spins up the worker

const buf = await ctx.decodeAudioData(await (await fetch('audio.wav')).arrayBuffer());

const out = await Timestretcher.timestretch(buf, { timeRatio: 1.5, semitones: 4 });

new AudioBufferSourceNode(ctx, { buffer: out }).start();
```

Pick the Rubber Band algorithm:

```javascript
Timestretcher.timestretch(buf, { engine: 'finer', formant: 'preserved' });
```

Options: `engine`, `formant`, `pitchMode`, `transients`, `detector`, `phase`,
`window`, `smoothing`, `channels`.

The defaults work well enough for me.

## Build

Needs the [Emscripten SDK](https://emscripten.org/docs/tools_reference/emsdk.html)

```bash
npm run build
```

## License

GPL-2.0-or-later as per rubberband. See [LICENSE](LICENSE).
