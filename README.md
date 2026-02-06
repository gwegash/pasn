# AudioBufferSourceNode with Pitch Shifting

A Web Audio API implementation that extends AudioBufferSourceNode with independent pitch shifting using the Rubberband audio processing library.

## Features

- **AudioBufferSourceNode compatible interface** - Drop-in replacement for native AudioBufferSourceNode
- **Independent pitch shifting** - Transpose audio without affecting playback rate using the `transpose` parameter
- **AudioWorklet implementation** - Low-latency audio processing using AudioWorklet
- **Rubberband integration** - High-quality pitch shifting using the Rubberband C++ library compiled to WebAssembly

## API

### PitchShiftBufferSource

Extends the standard AudioBufferSourceNode interface with an additional `transpose` parameter.

#### Properties

- `buffer` - AudioBuffer containing the audio data
- `playbackRate` - AudioParam controlling playback speed (affects pitch in standard implementation)
- `detune` - AudioParam for pitch adjustment in cents
- `transpose` - **NEW** AudioParam for pitch adjustment in semitones (independent of playback rate)
- `loop` - Boolean to enable/disable looping
- `loopStart` - Loop start time in seconds
- `loopEnd` - Loop end time in seconds

#### Methods

- `start(when?, offset?, duration?)` - Start playback
- `stop(when?)` - Stop playback

#### Events

- `ended` - Fired when playback ends

### Usage Example

```javascript
import { PitchShiftBufferSource } from './src/pitch-shift-buffer-source.js';

// Create audio context
const audioContext = new AudioContext();

// Create pitch-shifting buffer source
const source = await PitchShiftBufferSource.create(audioContext);

// Load audio buffer (same as standard AudioBufferSourceNode)
const response = await fetch('audio.wav');
const arrayBuffer = await response.arrayBuffer();
const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

// Configure the source
source.buffer = audioBuffer;
source.playbackRate.value = 1.0;  // Normal speed
source.transpose.value = 4;       // Pitch up 4 semitones (major third)

// Connect and play
source.connect(audioContext.destination);
source.start();
```

## Key Differences from Native AudioBufferSourceNode

1. **Independent pitch shifting**: The `transpose` parameter allows pitch adjustment without affecting playback speed
2. **AudioWorklet based**: Runs in AudioWorklet for low-latency processing
3. **Rubberband integration**: Uses high-quality pitch shifting algorithms

## Building

### Prerequisites

- Emscripten compiler
- Rubberband library source code
- Node.js (for development)

### Build Steps

1. Install Emscripten
2. Download and place Rubberband library in `./rubberband/`
3. Run build command:

```bash
npm run build
```

This will:
1. Compile the C++ wrapper with Emscripten
2. Generate WebAssembly module
3. Bundle JavaScript files

## Files

- `src/pitch-shift-processor.js` - AudioWorklet processor implementation
- `src/pitch-shift-buffer-source.js` - Main thread AudioNode wrapper
- `src/rubberband-wrapper.cpp` - C++ wrapper for Rubberband library
- `src/index.js` - Main export file
- `example.html` - Interactive demo

## Browser Requirements

- AudioWorklet support (Chrome 66+, Firefox 76+, Safari 14+)
- WebAssembly support
- ES6 modules support

## Performance Considerations

- The processor uses buffering to handle Rubberband's block-based processing
- Pitch shifting adds computational overhead compared to native AudioBufferSourceNode
- WebAssembly provides near-native performance for audio processing

## License

MIT