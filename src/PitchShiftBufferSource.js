window.PitchShiftBufferSource = class PitchShiftBufferSource extends AudioWorkletNode {
  constructor(context, options = {}) {
    super(context, 'pitch-shift-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: options
    });

    this._context = context;
    this._buffer = null;
    this._loop = false;
    this._loopStart = 0;
    this._loopEnd = 0;
    this._started = false;

    this.onended = null;

    this.port.onmessage = this.handleMessage.bind(this);
  }

  static async create(context, options = {}) {
    try {
      await context.audioWorklet.addModule('./build/processor.js');
    } catch (error) {
      console.warn('AudioWorklet module already added or failed to add:', error);
    }

    return new PitchShiftBufferSource(context, options);
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

  get loop() {
    return this._loop;
  }

  set loop(value) {
    this._loop = Boolean(value);
    this.port.postMessage({
      type: 'setLoop',
      data: {
        loop: this._loop,
        loopStart: this._loopStart,
        loopEnd: this._loopEnd
      }
    });
  }

  get loopStart() {
    return this._loopStart;
  }

  set loopStart(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new RangeError('loopStart must be a non-negative number');
    }
    this._loopStart = value;
    if (this._loop) {
      this.port.postMessage({
        type: 'setLoop',
        data: {
          loop: this._loop,
          loopStart: this._loopStart,
          loopEnd: this._loopEnd
        }
      });
    }
  }

  get loopEnd() {
    return this._loopEnd;
  }

  set loopEnd(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new RangeError('loopEnd must be a non-negative number');
    }
    this._loopEnd = value;
    if (this._loop) {
      this.port.postMessage({
        type: 'setLoop',
        data: {
          loop: this._loop,
          loopStart: this._loopStart,
          loopEnd: this._loopEnd
        }
      });
    }
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

  disconnect() {
    super.disconnect();
  }
};
