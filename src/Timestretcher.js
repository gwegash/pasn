// Replaced at bundle time by esbuild's `define` with the inlined worker source
// and wasm bytes. Left undefined in the raw source, where they're loaded by URL.
const INLINE_WORKER = typeof PSB_INLINE_WORKER !== 'undefined' ? PSB_INLINE_WORKER : null;
const INLINE_WASM_B64 = typeof PSB_INLINE_WASM !== 'undefined' ? PSB_INLINE_WASM : null;

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Offline time-stretching / pitch-shifting. Processing runs in a Web Worker
// (off the main and audio threads); the result is a plain AudioBuffer you can
// drop into an AudioBufferSourceNode for glitch-free, sample-accurate playback.
//
//   await Timestretcher.init();
//   const out = await Timestretcher.timestretch(buffer, { timeRatio, semitones });
//   new AudioBufferSourceNode(ctx, { buffer: out }).start(when);
export class Timestretcher {
  // RubberBand option flags (must match rubberband-c.h). One value per group is
  // OR'd into the bitmask; the C++ glue forces offline + single-threaded.
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

  // Offline can afford the higher-quality engine by default.
  static optionDefaults = {
    engine: 'finer',
    pitchMode: 'highQuality',
    transients: 'crisp',
    detector: 'compound',
    phase: 'laminar',
    window: 'standard',
    smoothing: 'off',
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

  // Asset locations for the un-bundled build, relative to this module. Lazy so
  // the bundled build (which inlines both) never touches import.meta.url.
  static get defaultWasmUrl() { return new URL('../build/rubberband-wasm.wasm', import.meta.url); }
  static get defaultWorkerUrl() { return new URL('./timestretch-worker.js', import.meta.url); }

  static _worker = null;
  static _readyPromise = null;
  static _jobId = 0;
  static _jobs = new Map();

  static getModule(overrideUrl) {
    if (!overrideUrl && INLINE_WASM_B64) {
      return WebAssembly.compile(base64ToBytes(INLINE_WASM_B64));
    }
    const url = overrideUrl || this.defaultWasmUrl;
    return fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`Failed to fetch WASM: ${response.status}`);
        return response.arrayBuffer();
      })
      .then(bytes => WebAssembly.compile(bytes));
  }

  // Compile the WASM and spin up the worker. Await once before timestretch().
  // options.wasmUrl / options.workerUrl override the inlined/default assets.
  static init(options = {}) {
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        const wasmModule = await this.getModule(options.wasmUrl);

        let workerUrl = options.workerUrl;
        let blobUrl = null;
        if (!workerUrl && INLINE_WORKER) {
          blobUrl = URL.createObjectURL(new Blob([INLINE_WORKER], { type: 'text/javascript' }));
          workerUrl = blobUrl;
        } else if (!workerUrl) {
          workerUrl = this.defaultWorkerUrl;
        }

        const worker = new Worker(workerUrl);
        worker.onmessage = (e) => this._onMessage(e.data);
        worker.onerror = (e) => {
          const err = new Error(e.message || 'Timestretcher worker error');
          for (const job of this._jobs.values()) job.reject(err);
          this._jobs.clear();
        };

        await new Promise((resolve, reject) => {
          this._initResolve = resolve;
          this._initReject = reject;
          worker.postMessage({ type: 'init', wasmModule });
        });

        if (blobUrl) URL.revokeObjectURL(blobUrl);
        this._worker = worker;
      })().catch((err) => {
        this._readyPromise = null; // allow a retry
        throw err;
      });
    }
    return this._readyPromise;
  }

  // Stretch/pitch-shift an AudioBuffer offline. Returns a Promise<AudioBuffer>.
  //   options.timeRatio  — output duration / input duration (1 = unchanged)
  //   options.semitones  — pitch shift in semitones (or options.cents, or options.pitchScale)
  //   options.<rbConfig> — engine/formant/window/… (see optionFlags)
  static timestretch(buffer, options = {}) {
    if (!this._worker) {
      return Promise.reject(new Error('Timestretcher: await Timestretcher.init() first.'));
    }

    const channels = buffer.numberOfChannels;
    const channelData = [];
    const transfers = [];
    for (let c = 0; c < channels; c++) {
      const copy = buffer.getChannelData(c).slice();
      channelData.push(copy);
      transfers.push(copy.buffer);
    }

    const timeRatio = options.timeRatio != null ? options.timeRatio : 1;
    const pitchScale = this._pitchScale(options);
    const rbOptions = this.buildOptions(options);
    const id = ++this._jobId;
    const sampleRate = buffer.sampleRate;

    return new Promise((resolve, reject) => {
      this._jobs.set(id, { resolve, reject, sampleRate });
      this._worker.postMessage(
        { type: 'stretch', id, channelData, sampleRate, timeRatio, pitchScale, options: rbOptions },
        transfers
      );
    });
  }

  static _pitchScale(options) {
    if (options.pitchScale != null) return options.pitchScale;
    return Math.pow(2, (options.semitones || 0) / 12 + (options.cents || 0) / 1200);
  }

  static _onMessage(msg) {
    if (msg.type === 'ready') {
      if (this._initResolve) this._initResolve();
      return;
    }
    const job = this._jobs.get(msg.id);
    if (!job) return;
    this._jobs.delete(msg.id);

    if (msg.type === 'error') {
      job.reject(new Error(msg.message));
      return;
    }

    const chData = msg.channelData;
    const length = Math.max(1, chData[0] ? chData[0].length : 0);
    const audioBuffer = new AudioBuffer({
      length,
      numberOfChannels: chData.length,
      sampleRate: job.sampleRate
    });
    for (let c = 0; c < chData.length; c++) {
      if (chData[c].length) audioBuffer.copyToChannel(chData[c], c);
    }
    job.resolve(audioBuffer);
  }
}
