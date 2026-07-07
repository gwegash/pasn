class RubberBandProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.ready = false;
    this.exports = null;
    this.memory = null;
    this.heapU8 = null;
    this.heapF32 = null;

    this.rb = null;
    this.bufferData = null;
    this.bufferSampleRate = 0;
    this.currentFrame = 0;
    this.isPlaying = false;
    this.hasEnded = false;
    this.startWhen = 0;
    this.stopWhen = -1;
    this.startOffset = 0;

    this.loop = false;
    this.loopStartFrame = 0;
    this.loopEndFrame = 0;
    this.loopFadeFrames = 0;

    this.rbChannels = 0;
    this.rbInitialized = false;
    this.sourceExhausted = false;
    this.inputPtr = 0;
    this.outputPtr = 0;
    this.maxBlock = 2048;

    this.wasmModule = options.processorOptions && options.processorOptions.wasmModule;
    this.rbOptions = (options.processorOptions && options.processorOptions.rubberbandOptions) || 0;

    // Node output channel count (fixed for the node's lifetime); used to size
    // RubberBand ahead of the first render so init/prime stay off the hot path.
    this.outputChannels = (options.outputChannelCount && options.outputChannelCount[0]) || 2;

    // Reusable per-channel scratch for source reads — never allocate in process().
    this.scratch = null;

    this.port.onmessage = this.handleMessage.bind(this);
    this.initWasm();
  }

  static get parameterDescriptors() {
    return [
      { name: 'playbackRate', defaultValue: 1.0, minValue: 0.01, maxValue: 10.0, automationRate: 'k-rate' },
      { name: 'detune', defaultValue: 0, minValue: -153600, maxValue: 153600, automationRate: 'k-rate' },
      { name: 'transpose', defaultValue: 0, minValue: -48, maxValue: 48, automationRate: 'k-rate' }
    ];
  }

  updateHeapViews() {
    this.heapU8 = new Uint8Array(this.memory.buffer);
    this.heapF32 = new Float32Array(this.memory.buffer);
  }

  async initWasm() {
    try {
      const self = this;
      const imports = {
        env: {
          __assert_fail: () => { throw new Error('assert failed'); },
          __cxa_throw: () => { throw new Error('C++ exception'); },
          abort: () => { throw new Error('abort'); },
          emscripten_date_now: () => Date.now(),
          emscripten_memcpy_js: (dest, src, num) => self.heapU8.copyWithin(dest, src, src + num),
          emscripten_resize_heap: (requestedSize) => {
            const pages = Math.ceil((requestedSize - self.memory.buffer.byteLength) / 65536);
            if (pages > 0) {
              try { self.memory.grow(pages); } catch (e) { return 0; }
              self.updateHeapViews();
            }
            return 1;
          },
          strftime_l: () => 0,
        },
        wasi_snapshot_preview1: {
          environ_get: () => 0,
          environ_sizes_get: () => 0,
          fd_close: () => 0,
          fd_read: () => 0,
          fd_seek: () => 0,
          fd_write: () => 0,
        }
      };

      // this.wasmModule is an already-compiled WebAssembly.Module, so
      // instantiate() resolves to an Instance directly (no recompilation).
      const instance = await WebAssembly.instantiate(this.wasmModule, imports);
      this.exports = instance.exports;
      this.memory = this.exports.memory;
      this.updateHeapViews();

      if (this.exports.__wasm_call_ctors) {
        this.exports.__wasm_call_ctors();
      }

      this.ready = true;
      // If the buffer already arrived, set RubberBand up now (while silent)
      // rather than on the first process() call.
      this.maybeInitRubberband();
      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.port.postMessage({ type: 'error', message: e.message });
    }
  }

  // Initialize RubberBand once both the WASM and the source buffer are ready.
  // Runs at ready/setBuffer time (output still silent) instead of inside the
  // first process() call, so the allocation + priming can't glitch playback.
  maybeInitRubberband() {
    if (!this.ready || !this.bufferData) return;
    const channels = Math.min(this.bufferData.length, this.outputChannels);
    if (!this.rbInitialized || this.rbChannels !== channels) {
      this.initRubberband(channels);
    }
  }

  initRubberband(channels) {
    if (this.rb) {
      this.exports.rb_delete(this.rb);
      if (this.inputPtr) this.exports.rb_free(this.inputPtr);
      if (this.outputPtr) this.exports.rb_free(this.outputPtr);
    }

    this.rbChannels = channels;
    this.rb = this.exports.rb_new(sampleRate, channels, this.rbOptions);
    this.exports.rb_set_max_process_size(this.rb, this.maxBlock);

    this.inputPtr = this.exports.rb_alloc(this.maxBlock * channels);
    this.outputPtr = this.exports.rb_alloc(this.maxBlock * channels);

    this.scratch = [];
    for (let c = 0; c < channels; c++) {
      this.scratch.push(new Float32Array(this.maxBlock));
    }

    this.primeRubberband();
    this.rbInitialized = true;
  }

  primeRubberband() {
    const channels = this.rbChannels;
    const inputOffset = this.inputPtr >> 2;

    for (let i = 0; i < this.maxBlock * channels; i++) {
      this.heapF32[inputOffset + i] = 0;
    }

    let remaining = this.exports.rb_get_preferred_start_pad(this.rb);
    while (remaining > 0) {
      const chunk = Math.min(remaining, this.maxBlock);
      this.exports.rb_process(this.rb, this.inputPtr, chunk, channels, 0);
      remaining -= chunk;
    }

    const startDelay = this.exports.rb_get_start_delay(this.rb);
    let safety = 0;
    while (this.exports.rb_available(this.rb) < startDelay && safety < 64) {
      safety++;
      const needed = Math.min(this.exports.rb_get_samples_required(this.rb), this.maxBlock);
      if (needed === 0) break;
      this.exports.rb_process(this.rb, this.inputPtr, needed, channels, 0);
    }

    const toDiscard = Math.min(startDelay, this.exports.rb_available(this.rb));
    if (toDiscard > 0) {
      this.exports.rb_retrieve(this.rb, this.outputPtr, toDiscard, channels);
    }
  }

  sampleAt(frame, channel) {
    const chData = channel < this.bufferData.length
      ? this.bufferData[channel] : this.bufferData[0];
    const intFrame = Math.floor(frame);
    const frac = frame - intFrame;
    const s0 = intFrame < chData.length ? chData[intFrame] : 0;
    const s1 = (intFrame + 1) < chData.length ? chData[intFrame + 1] : 0;
    return s0 + (s1 - s0) * frac;
  }

  readSourceSamples(channels, count, effectiveRate) {
    // Reuse preallocated scratch — process() must not allocate on the audio thread.
    const result = this.scratch;

    const bufLen = this.bufferData[0].length;
    let endFrame = this.loopEndFrame;
    if (!this.loop || endFrame <= this.loopStartFrame) {
      endFrame = bufLen;
    }

    const loopLen = endFrame - this.loopStartFrame;
    const fadeFrames = (this.loop && this.loopFadeFrames > 0)
      ? Math.min(this.loopFadeFrames, loopLen) : 0;
    const fadeStart = endFrame - fadeFrames;

    let reachedEnd = false;

    for (let i = 0; i < count; i++) {
      if (this.currentFrame >= endFrame) {
        if (this.loop) {
          this.currentFrame = this.loopStartFrame + fadeFrames
            + (this.currentFrame - endFrame);
          if (this.currentFrame >= endFrame) this.currentFrame = this.loopStartFrame + fadeFrames;
        } else {
          reachedEnd = true;
          for (let j = i; j < count; j++) {
            for (let c = 0; c < channels; c++) {
              result[c][j] = 0;
            }
          }
          break;
        }
      }

      for (let c = 0; c < channels; c++) {
        let sample = this.sampleAt(this.currentFrame, c);

        if (fadeFrames > 0 && this.currentFrame >= fadeStart) {
          const fadePos = this.currentFrame - fadeStart;
          const t = fadePos / fadeFrames;
          const crossFrame = this.loopStartFrame + fadePos;
          const crossSample = this.sampleAt(crossFrame, c);
          sample = sample * (1 - t) + crossSample * t;
        }

        result[c][i] = sample;
      }

      this.currentFrame += effectiveRate;
    }

    return { samples: result, reachedEnd };
  }

  handleMessage(event) {
    const { type, data } = event.data;

    switch (type) {
      case 'setBuffer':
        this.bufferData = data.channelData;
        this.bufferSampleRate = data.sampleRate;
        this.currentFrame = 0;
        this.hasEnded = false;
        // Set RubberBand up now (while silent) so the first render doesn't pay
        // for allocation + priming.
        this.maybeInitRubberband();
        break;

      case 'start':
        this.isPlaying = true;
        this.hasEnded = false;
        this.sourceExhausted = false;
        this.startWhen = data.when || 0;
        this.startOffset = data.offset || 0;
        this.currentFrame = this.startOffset * sampleRate;
        this.stopWhen = data.duration !== undefined
          ? (this.startWhen || currentTime) + data.duration
          : -1;
        if (this.rb) {
          this.exports.rb_reset(this.rb);
          this.primeRubberband();
        }
        break;

      case 'stop':
        this.isPlaying = false;
        if (!this.hasEnded) {
          this.hasEnded = true;
          this.port.postMessage({ type: 'ended' });
        }
        break;

      case 'setLoop':
        this.loop = data.loop;
        this.loopStartFrame = Math.floor((data.loopStart || 0) * sampleRate);
        this.loopEndFrame = Math.floor((data.loopEnd || 0) * sampleRate);
        this.loopFadeFrames = Math.floor((data.loopFade || 0) * sampleRate);
        break;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output.length) return true;

    const frameCount = output[0].length;
    const outChannels = output.length;

    if (!this.ready || !this.isPlaying || !this.bufferData || this.hasEnded) {
      for (let c = 0; c < outChannels; c++) {
        output[c].fill(0);
      }
      return true;
    }

    if (this.startWhen > currentTime) {
      for (let c = 0; c < outChannels; c++) {
        output[c].fill(0);
      }
      return true;
    }

    if (this.stopWhen >= 0 && currentTime >= this.stopWhen) {
      this.isPlaying = false;
      if (!this.hasEnded) {
        this.hasEnded = true;
        this.port.postMessage({ type: 'ended' });
      }
      for (let c = 0; c < outChannels; c++) {
        output[c].fill(0);
      }
      return true;
    }

    const channels = Math.min(this.bufferData.length, outChannels);
    if (!this.rbInitialized || this.rbChannels !== channels) {
      this.initRubberband(channels);
    }

    const playbackRate = parameters.playbackRate[0] || 1.0;
    const detune = parameters.detune[0] || 0;
    const transpose = parameters.transpose[0] || 0;

    // detune (cents) and transpose (semitones) both shift pitch independently
    // of tempo, so they go through RubberBand. playbackRate alone drives the
    // source read rate (speed).
    const effectiveRate = playbackRate;
    const pitchScale = Math.pow(2, transpose / 12 + detune / 1200);

    this.exports.rb_set_pitch_scale(this.rb, pitchScale);

    const inputOffset = this.inputPtr >> 2;
    const outputOffset = this.outputPtr >> 2;

    if (!this.sourceExhausted) {
      let safety = 0;
      while (this.exports.rb_available(this.rb) < frameCount && safety < 32) {
        safety++;

        const needed = Math.min(this.exports.rb_get_samples_required(this.rb), this.maxBlock);
        if (needed === 0) break;

        const { samples, reachedEnd } = this.readSourceSamples(channels, needed, effectiveRate);

        for (let c = 0; c < channels; c++) {
          this.heapF32.set(samples[c].subarray(0, needed), inputOffset + c * needed);
        }

        this.exports.rb_process(this.rb, this.inputPtr, needed, channels, reachedEnd ? 1 : 0);

        if (reachedEnd && !this.loop) {
          this.sourceExhausted = true;
          break;
        }
      }
    }

    const avail = this.exports.rb_available(this.rb);
    if (avail <= 0 && this.sourceExhausted) {
      if (!this.hasEnded) {
        this.hasEnded = true;
        this.isPlaying = false;
        this.port.postMessage({ type: 'ended' });
      }
      for (let c = 0; c < outChannels; c++) {
        output[c].fill(0);
      }
      return true;
    }

    const toRetrieve = Math.min(avail, frameCount);
    if (toRetrieve > 0) {
      this.exports.rb_retrieve(this.rb, this.outputPtr, toRetrieve, channels);
      for (let c = 0; c < channels; c++) {
        const start = outputOffset + c * toRetrieve;
        output[c].set(this.heapF32.subarray(start, start + toRetrieve));
      }
    }
    for (let c = 0; c < channels; c++) {
      for (let i = toRetrieve; i < frameCount; i++) {
        output[c][i] = 0;
      }
    }

    for (let c = channels; c < outChannels; c++) {
      output[c].set(output[0]);
    }

    return true;
  }
}

registerProcessor('pitch-shift-processor', RubberBandProcessor);
