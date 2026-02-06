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
    this.inputPtr = 0;
    this.outputPtr = 0;
    this.maxBlock = 2048;

    this.startDelay = 0;
    this.discarded = 0;

    this.outRingSize = 16384;
    this.outRing = null;
    this.outRingReadPos = 0;
    this.outRingWritePos = 0;

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
      this.mod = await createRubberBandModule();
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

  ensureRubberbandInitialized(channels) {
    if (this.rbInitialized && this.rbChannels === channels) return;

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

    // Feed initial padding
    const padSamples = this.api.rb_get_preferred_start_pad(this.rb);
    if (padSamples > 0) {
      const padPtr = this.api.rb_alloc(padSamples * channels);
      const heapF32 = this.mod.HEAPF32;
      const padOffset = padPtr >> 2;
      for (let i = 0; i < padSamples * channels; i++) {
        heapF32[padOffset + i] = 0;
      }
      this.api.rb_process(this.rb, padPtr, padSamples, channels, 0);
      this.api.rb_free(padPtr);
    }

    this.startDelay = this.api.rb_get_start_delay(this.rb);
    this.discarded = 0;

    // Initialize ring buffer
    this.outRing = [];
    for (let c = 0; c < channels; c++) {
      this.outRing.push(new Float32Array(this.outRingSize));
    }
    this.outRingReadPos = 0;
    this.outRingWritePos = 0;

    this.rbInitialized = true;
  }

  ringAvailable() {
    return (this.outRingWritePos - this.outRingReadPos + this.outRingSize) % this.outRingSize;
  }

  ringFree() {
    return this.outRingSize - 1 - this.ringAvailable();
  }

  ringWrite(channels, data, frames) {
    const free = this.ringFree();
    const toWrite = Math.min(frames, free);
    for (let i = 0; i < toWrite; i++) {
      const pos = (this.outRingWritePos + i) % this.outRingSize;
      for (let c = 0; c < channels; c++) {
        this.outRing[c][pos] = data[c][i];
      }
    }
    this.outRingWritePos = (this.outRingWritePos + toWrite) % this.outRingSize;
    return toWrite;
  }

  ringRead(channels, output, frames) {
    const avail = this.ringAvailable();
    const toRead = Math.min(frames, avail);
    for (let i = 0; i < toRead; i++) {
      const pos = (this.outRingReadPos + i) % this.outRingSize;
      for (let c = 0; c < channels; c++) {
        output[c][i] = this.outRing[c][pos];
      }
    }
    this.outRingReadPos = (this.outRingReadPos + toRead) % this.outRingSize;
    // Zero-fill remainder
    for (let i = toRead; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        output[c][i] = 0;
      }
    }
    return toRead;
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
          // Zero-fill rest
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

  fillRingBuffer(channels, effectiveRate, pitchScale) {
    this.api.rb_set_pitch_scale(this.rb, pitchScale);

    const heapF32 = this.mod.HEAPF32;
    const inputOffset = this.inputPtr >> 2;
    const outputOffset = this.outputPtr >> 2;

    let iterations = 0;
    while (this.ringAvailable() < 256 && iterations < 32) {
      iterations++;

      let needed = this.api.rb_get_samples_required(this.rb);
      if (needed === 0) needed = 128;
      needed = Math.min(needed, this.maxBlock);

      const { samples, reachedEnd } = this.readSourceSamples(channels, needed, effectiveRate);

      // Copy to WASM heap (channel-sequential)
      for (let c = 0; c < channels; c++) {
        for (let i = 0; i < needed; i++) {
          heapF32[inputOffset + c * needed + i] = samples[c][i];
        }
      }

      this.api.rb_process(this.rb, this.inputPtr, needed, channels, reachedEnd ? 1 : 0);

      // Retrieve available output
      const avail = this.api.rb_available(this.rb);
      if (avail > 0) {
        const toRetrieve = Math.min(avail, this.maxBlock);
        const retrieved = this.api.rb_retrieve(this.rb, this.outputPtr, toRetrieve, channels);

        if (retrieved > 0) {
          // Handle start delay discard
          let outStart = 0;
          let outCount = retrieved;
          if (this.discarded < this.startDelay) {
            const toDiscard = Math.min(this.startDelay - this.discarded, outCount);
            this.discarded += toDiscard;
            outStart = toDiscard;
            outCount -= toDiscard;
          }

          if (outCount > 0) {
            // Read from WASM heap (channel-sequential) into temp arrays
            const tempData = [];
            for (let c = 0; c < channels; c++) {
              const arr = new Float32Array(outCount);
              for (let i = 0; i < outCount; i++) {
                arr[i] = heapF32[outputOffset + c * toRetrieve + outStart + i];
              }
              tempData.push(arr);
            }
            this.ringWrite(channels, tempData, outCount);
          }
        }
      }

      if (reachedEnd && !this.loop) {
        break;
      }
    }
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
        this.startWhen = data.when || 0;
        this.startOffset = data.offset || 0;
        this.currentFrame = this.startOffset * sampleRate;
        this.stopWhen = data.duration !== undefined
          ? (this.startWhen || currentTime) + data.duration
          : -1;
        // Reset rubberband state for fresh playback
        if (this.rb) {
          this.api.rb_reset(this.rb);
          this.discarded = 0;
          // Re-feed padding
          const padSamples = this.api.rb_get_preferred_start_pad(this.rb);
          if (padSamples > 0) {
            const padPtr = this.api.rb_alloc(padSamples * this.rbChannels);
            const heapF32 = this.mod.HEAPF32;
            const padOff = padPtr >> 2;
            for (let i = 0; i < padSamples * this.rbChannels; i++) {
              heapF32[padOff + i] = 0;
            }
            this.api.rb_process(this.rb, padPtr, padSamples, this.rbChannels, 0);
            this.api.rb_free(padPtr);
          }
          this.outRingReadPos = 0;
          this.outRingWritePos = 0;
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
    this.ensureRubberbandInitialized(channels);

    const playbackRate = parameters.playbackRate[0] || 1.0;
    const detune = parameters.detune[0] || 0;
    const transpose = parameters.transpose[0] || 0;

    const detuneRatio = Math.pow(2, detune / 1200);
    const effectiveRate = playbackRate * detuneRatio;
    const pitchScale = Math.pow(2, transpose / 12);

    // Fill ring buffer from rubberband
    this.fillRingBuffer(channels, effectiveRate, pitchScale);

    // Read from ring buffer to output
    const avail = this.ringAvailable();
    if (avail === 0 && !this.loop) {
      // Source exhausted and ring empty
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

    this.ringRead(channels, output, frameCount);

    // If buffer has fewer channels than output, copy channel 0 to remaining
    for (let c = channels; c < outChannels; c++) {
      output[c].set(output[0]);
    }

    return true;
  }
}

registerProcessor('pitch-shift-processor', RubberBandProcessor);
