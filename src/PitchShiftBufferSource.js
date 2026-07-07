window.PitchShiftBufferSource = class PitchShiftBufferSource extends AudioWorkletNode {
  constructor(context, options = {}) {
    super(context, 'pitch-shift-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: options
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

  // Compile the WASM once per page; the compiled Module is shared across every
  // instance and stays off the audio render thread.
  static _modulePromise = null;

  static getModule() {
    if (!this._modulePromise) {
      this._modulePromise = fetch('./build/rubberband-wasm.wasm')
        .then(response => {
          if (!response.ok) throw new Error(`Failed to fetch WASM: ${response.status}`);
          return response.arrayBuffer();
        })
        .then(bytes => WebAssembly.compile(bytes))
        .catch(err => {
          // Don't cache a failure — allow a later create() to retry.
          this._modulePromise = null;
          throw err;
        });
    }
    return this._modulePromise;
  }

  static async create(context, options = {}) {
    const wasmModule = await this.getModule();

    try {
      await context.audioWorklet.addModule('./build/processor.js');
    } catch (error) {
      console.warn('AudioWorklet module already added or failed to add:', error);
    }

    const rubberbandOptions = this.buildOptions(options);

    return new PitchShiftBufferSource(context, { ...options, wasmModule, rubberbandOptions });
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
};
