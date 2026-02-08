class RubberBandProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.ready = false;
    this.rb = null;
    this.mod = null;
    this.api = null;

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

    this.rbChannels = 0;
    this.rbInitialized = false;
    this.sourceExhausted = false;
    this.inputPtr = 0;
    this.outputPtr = 0;
    this.maxBlock = 2048;

    this.wasmModule = options.processorOptions && options.processorOptions.wasmModule;

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

  async initWasm() {
    try {
      const wasmModule = this.wasmModule;
      this.mod = await createRubberBandModule({
        instantiateWasm(imports, successCallback) {
          WebAssembly.instantiate(wasmModule, imports).then(instance => {
            successCallback(instance);
          });
          return {};
        }
      });
      this.api = {
        rb_new: this.mod.cwrap('rb_new', 'number', ['number', 'number']),
        rb_delete: this.mod.cwrap('rb_delete', null, ['number']),
        rb_set_pitch_scale: this.mod.cwrap('rb_set_pitch_scale', null, ['number', 'number']),
        rb_get_samples_required: this.mod.cwrap('rb_get_samples_required', 'number', ['number']),
        rb_get_preferred_start_pad: this.mod.cwrap('rb_get_preferred_start_pad', 'number', ['number']),
        rb_get_start_delay: this.mod.cwrap('rb_get_start_delay', 'number', ['number']),
        rb_set_max_process_size: this.mod.cwrap('rb_set_max_process_size', null, ['number', 'number']),
        rb_process: this.mod.cwrap('rb_process', null, ['number', 'number', 'number', 'number', 'number']),
        rb_available: this.mod.cwrap('rb_available', 'number', ['number']),
        rb_retrieve: this.mod.cwrap('rb_retrieve', 'number', ['number', 'number', 'number', 'number']),
        rb_reset: this.mod.cwrap('rb_reset', null, ['number']),
        rb_alloc: this.mod.cwrap('rb_alloc', 'number', ['number']),
        rb_free: this.mod.cwrap('rb_free', null, ['number']),
      };
      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.port.postMessage({ type: 'error', message: e.message });
    }
  }

  initRubberband(channels) {
    if (this.rb) {
      this.api.rb_delete(this.rb);
      if (this.inputPtr) this.api.rb_free(this.inputPtr);
      if (this.outputPtr) this.api.rb_free(this.outputPtr);
    }

    this.rbChannels = channels;
    this.rb = this.api.rb_new(sampleRate, channels);
    this.api.rb_set_max_process_size(this.rb, this.maxBlock);

    this.inputPtr = this.api.rb_alloc(this.maxBlock * channels);
    this.outputPtr = this.api.rb_alloc(this.maxBlock * channels);

    this.primeRubberband();
    this.rbInitialized = true;
  }

  primeRubberband() {
    const channels = this.rbChannels;
    const heapF32 = this.mod.HEAPF32;
    const inputOffset = this.inputPtr >> 2;

    // Zero the input buffer — reused for all silent feeds below
    for (let i = 0; i < this.maxBlock * channels; i++) {
      heapF32[inputOffset + i] = 0;
    }

    // Feed silent padding to prime RubberBand's internal buffers
    let remaining = this.api.rb_get_preferred_start_pad(this.rb);
    while (remaining > 0) {
      const chunk = Math.min(remaining, this.maxBlock);
      this.api.rb_process(this.rb, this.inputPtr, chunk, channels, 0);
      remaining -= chunk;
    }

    // Keep feeding silence until enough output exists to discard the full start delay
    const startDelay = this.api.rb_get_start_delay(this.rb);
    let safety = 0;
    while (this.api.rb_available(this.rb) < startDelay && safety < 64) {
      safety++;
      const needed = Math.min(this.api.rb_get_samples_required(this.rb), this.maxBlock);
      if (needed === 0) break;
      this.api.rb_process(this.rb, this.inputPtr, needed, channels, 0);
    }

    // Discard start delay so first real output aligns with source
    const toDiscard = Math.min(startDelay, this.api.rb_available(this.rb));
    if (toDiscard > 0) {
      this.api.rb_retrieve(this.rb, this.outputPtr, toDiscard, channels);
    }
  }

  readSourceSamples(channels, count, effectiveRate) {
    const result = [];
    for (let c = 0; c < channels; c++) {
      result.push(new Float32Array(count));
    }

    const bufLen = this.bufferData[0].length;
    let endFrame = this.loopEndFrame;
    if (!this.loop || endFrame <= this.loopStartFrame) {
      endFrame = bufLen;
    }

    let reachedEnd = false;

    for (let i = 0; i < count; i++) {
      if (this.currentFrame >= endFrame) {
        if (this.loop) {
          this.currentFrame = this.loopStartFrame + (this.currentFrame - endFrame);
          if (this.currentFrame >= endFrame) this.currentFrame = this.loopStartFrame;
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

      const intFrame = Math.floor(this.currentFrame);
      const frac = this.currentFrame - intFrame;

      for (let c = 0; c < channels; c++) {
        const chData = c < this.bufferData.length ? this.bufferData[c] : this.bufferData[0];
        const s0 = intFrame < chData.length ? chData[intFrame] : 0;
        const s1 = (intFrame + 1) < chData.length ? chData[intFrame + 1] : 0;
        result[c][i] = s0 + (s1 - s0) * frac;
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
          this.api.rb_reset(this.rb);
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

    // Check scheduled start
    if (this.startWhen > currentTime) {
      for (let c = 0; c < outChannels; c++) {
        output[c].fill(0);
      }
      return true;
    }

    // Check scheduled stop
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

    const detuneRatio = Math.pow(2, detune / 1200);
    const effectiveRate = playbackRate * detuneRatio;
    const pitchScale = Math.pow(2, transpose / 12);

    this.api.rb_set_pitch_scale(this.rb, pitchScale);

    const heapF32 = this.mod.HEAPF32;
    const inputOffset = this.inputPtr >> 2;
    const outputOffset = this.outputPtr >> 2;

    // Feed RubberBand until it has enough output for this frame
    if (!this.sourceExhausted) {
      let safety = 0;
      while (this.api.rb_available(this.rb) < frameCount && safety < 32) {
        safety++;

        const needed = Math.min(this.api.rb_get_samples_required(this.rb), this.maxBlock);
        if (needed === 0) break;

        const { samples, reachedEnd } = this.readSourceSamples(channels, needed, effectiveRate);

        for (let c = 0; c < channels; c++) {
          for (let i = 0; i < needed; i++) {
            heapF32[inputOffset + c * needed + i] = samples[c][i];
          }
        }

        this.api.rb_process(this.rb, this.inputPtr, needed, channels, reachedEnd ? 1 : 0);

        if (reachedEnd && !this.loop) {
          this.sourceExhausted = true;
          break;
        }
      }
    }

    // Retrieve output directly — drain whatever RubberBand has
    const avail = this.api.rb_available(this.rb);
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
      this.api.rb_retrieve(this.rb, this.outputPtr, toRetrieve, channels);
      for (let c = 0; c < channels; c++) {
        for (let i = 0; i < toRetrieve; i++) {
          output[c][i] = heapF32[outputOffset + c * toRetrieve + i];
        }
      }
    }
    // Zero-fill any remainder
    for (let c = 0; c < channels; c++) {
      for (let i = toRetrieve; i < frameCount; i++) {
        output[c][i] = 0;
      }
    }

    // Copy to any extra output channels
    for (let c = channels; c < outChannels; c++) {
      output[c].set(output[0]);
    }

    return true;
  }
}

registerProcessor('pitch-shift-processor', RubberBandProcessor);
