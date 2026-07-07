// Replaced at bundle time by esbuild's `define` with the inlined assets. Left
// undefined in the raw source, where init() fetches them by URL instead.
// (typeof on an undeclared identifier is safe and yields 'undefined'.)
const INLINE_PROCESSOR = typeof PSB_INLINE_PROCESSOR !== 'undefined' ? PSB_INLINE_PROCESSOR : null;
const INLINE_WASM_B64 = typeof PSB_INLINE_WASM !== 'undefined' ? PSB_INLINE_WASM : null;

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class PitchShiftBufferSource extends AudioWorkletNode {
  constructor(context, options = {}) {
    const entry = PitchShiftBufferSource._ready.get(context);
    if (!entry || !entry.module) {
      throw new Error(
        'PitchShiftBufferSource: await PitchShiftBufferSource.init(context) before constructing.');
    }

    const rubberbandOptions = PitchShiftBufferSource.buildOptions(options);

    super(context, 'pitch-shift-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmModule: entry.module, rubberbandOptions }
    });

    this._buffer = null;
    this._loop = false;
    this._loopStart = 0;
    this._loopEnd = 0;
    this._loopFade = 0;
    this._started = false;

    this.onended = null;

    this.port.onmessage = this.handleMessage.bind(this);
  }

  // RubberBand option flags (must match rubberband-c.h). Each group is
  // mutually exclusive; one value from each is OR'd into the bitmask.
  // ProcessRealTime and ThreadingNever are forced on in the C++ glue.
  static optionFlags = {
    engine:     { faster: 0x00000000, finer: 0x20000000 },
    pitchMode:  { highSpeed: 0x00000000, highQuality: 0x02000000, highConsistency: 0x04000000 },
    transients: { crisp: 0x00000000, mixed: 0x00000100, smooth: 0x00000200 },
    detector:   { compound: 0x00000000, percussive: 0x00000400, soft: 0x00000800 },
    phase:      { laminar: 0x00000000, independent: 0x00002000 },
    window:     { standard: 0x00000000, short: 0x00100000, long: 0x00200000 },
    smoothing:  { off: 0x00000000, on: 0x00800000 },
    formant:    { shifted: 0x00000000, preserved: 0x01000000 },
    channels:   { apart: 0x00000000, together: 0x10000000 }
  };

  // Defaults reproduce the original hardcoded recipe when nothing is passed.
  static optionDefaults = {
    engine: 'faster',
    pitchMode: 'highConsistency',
    transients: 'crisp',
    detector: 'compound',
    phase: 'laminar',
    window: 'standard',
    smoothing: 'on',
    formant: 'shifted',
    channels: 'apart'
  };

  static buildOptions(opts = {}) {
    let bits = 0;
    for (const group of Object.keys(this.optionDefaults)) {
      const choice = opts[group] || this.optionDefaults[group];
      const flags = this.optionFlags[group];
      if (!(choice in flags)) {
        throw new RangeError(
          `Invalid ${group}: "${choice}". Valid values: ${Object.keys(flags).join(', ')}`);
      }
      bits |= flags[choice];
    }
    return bits;
  }

  // Default asset locations for the un-bundled build, resolved relative to this
  // module. Lazy getters so the bundled build (which inlines both assets) never
  // touches import.meta.url. Override via init()'s wasmUrl / processorUrl.
  static get defaultWasmUrl() { return new URL('../build/rubberband-wasm.wasm', import.meta.url); }
  static get defaultProcessorUrl() { return new URL('../build/processor.js', import.meta.url); }

  // Compile the WASM once (per source); the compiled Module is shared across
  // every instance and stays off the audio render thread. An explicit
  // overrideUrl wins; otherwise the inlined wasm is used, else the default URL.
  static _modules = new Map();

  static getModule(overrideUrl) {
    const useInline = !overrideUrl && INLINE_WASM_B64;
    const url = overrideUrl || (useInline ? null : this.defaultWasmUrl);
    const key = useInline ? 'inline' : String(url);
    if (!this._modules.has(key)) {
      const bytes = useInline
        ? Promise.resolve(base64ToBytes(INLINE_WASM_B64))
        : fetch(url).then(response => {
            if (!response.ok) throw new Error(`Failed to fetch WASM: ${response.status}`);
            return response.arrayBuffer();
          });
      const promise = bytes
        .then(b => WebAssembly.compile(b))
        .catch(err => {
          // Don't cache a failure — allow a later init() to retry.
          this._modules.delete(key);
          throw err;
        });
      this._modules.set(key, promise);
    }
    return this._modules.get(key);
  }

  // Per-context readiness: context -> { module, promise }. The compiled Module
  // is stored so the constructor can run synchronously once init() has resolved.
  static _ready = new WeakMap();

  // Prepare a context for synchronous construction: compile the WASM and
  // register the worklet processor. Await this once, near `new AudioContext()`;
  // afterwards `new PitchShiftBufferSource(context)` works synchronously.
  // Idempotent per context; concurrent/repeat calls share one promise.
  static init(context, options = {}) {
    let entry = this._ready.get(context);
    if (!entry) {
      entry = { module: null, promise: null };
      entry.promise = (async () => {
        const wasmModule = await this.getModule(options.wasmUrl);

        // Explicit URL wins; otherwise register the inlined processor via a
        // blob URL, else fall back to the default file URL.
        let processorUrl = options.processorUrl;
        let blobUrl = null;
        if (!processorUrl && INLINE_PROCESSOR) {
          blobUrl = URL.createObjectURL(
            new Blob([INLINE_PROCESSOR], { type: 'text/javascript' }));
          processorUrl = blobUrl;
        } else if (!processorUrl) {
          processorUrl = this.defaultProcessorUrl;
        }

        try {
          await context.audioWorklet.addModule(processorUrl);
        } finally {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
        }

        entry.module = wasmModule;
        return entry;
      })();
      // On failure, forget it so a later init() can retry.
      entry.promise.catch(() => this._ready.delete(context));
      this._ready.set(context, entry);
    }
    return entry.promise;
  }

  get buffer() {
    return this._buffer;
  }

  set buffer(audioBuffer) {
    this._buffer = audioBuffer;

    if (audioBuffer) {
      const channelData = [];
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        channelData.push(audioBuffer.getChannelData(ch));
      }

      this.port.postMessage({
        type: 'setBuffer',
        data: { channelData, sampleRate: audioBuffer.sampleRate }
      });
    }
  }

  get playbackRate() {
    return this.parameters.get('playbackRate');
  }

  get detune() {
    return this.parameters.get('detune');
  }

  get transpose() {
    return this.parameters.get('transpose');
  }

  _sendLoop() {
    this.port.postMessage({
      type: 'setLoop',
      data: {
        loop: this._loop,
        loopStart: this._loopStart,
        loopEnd: this._loopEnd,
        loopFade: this._loopFade
      }
    });
  }

  get loop() {
    return this._loop;
  }

  set loop(value) {
    this._loop = Boolean(value);
    this._sendLoop();
  }

  get loopStart() {
    return this._loopStart;
  }

  set loopStart(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new RangeError('loopStart must be a non-negative number');
    }
    this._loopStart = value;
    if (this._loop) this._sendLoop();
  }

  get loopEnd() {
    return this._loopEnd;
  }

  set loopEnd(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new RangeError('loopEnd must be a non-negative number');
    }
    this._loopEnd = value;
    if (this._loop) this._sendLoop();
  }

  get loopFade() {
    return this._loopFade;
  }

  set loopFade(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new RangeError('loopFade must be a non-negative number');
    }
    this._loopFade = value;
    if (this._loop) this._sendLoop();
  }

  start(when = 0, offset = 0, duration) {
    if (this._started) {
      throw new DOMException(
        'Cannot call start more than once',
        'InvalidStateError'
      );
    }

    if (!this._buffer) {
      throw new DOMException(
        'Cannot start without a buffer',
        'InvalidStateError'
      );
    }

    this._started = true;

    this.port.postMessage({
      type: 'start',
      data: { when, offset, duration }
    });
  }

  stop(when = 0) {
    if (!this._started) {
      throw new DOMException(
        'Cannot stop before starting',
        'InvalidStateError'
      );
    }

    this.port.postMessage({
      type: 'stop',
      data: { when }
    });
  }

  handleMessage(event) {
    const { type } = event.data;

    switch (type) {
      case 'ended':
        if (this.onended && typeof this.onended === 'function') {
          this.onended(new Event('ended'));
        }
        this.dispatchEvent(new Event('ended'));
        break;

      case 'ready':
        this.dispatchEvent(new Event('processorready'));
        break;

      case 'error':
        console.error('Processor error:', event.data.message);
        break;
    }
  }
}
