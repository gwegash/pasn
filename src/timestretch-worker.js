// Web Worker: runs RubberBand offline time-stretching / pitch-shifting on whole
// buffers, off the main and audio threads. Receives a compiled WASM Module and
// stretch jobs; returns the stretched channel data. Self-contained (no imports)
// so it can be loaded from a URL or an inlined blob.

let wasmExports = null;
let wasmMemory = null;
let heapU8 = null;
let heapF32 = null;

const BLOCK = 8192; // samples per feed/retrieve chunk

function updateHeapViews() {
  heapU8 = new Uint8Array(wasmMemory.buffer);
  heapF32 = new Float32Array(wasmMemory.buffer);
}

async function instantiate(wasmModule) {
  const imports = {
    env: {
      __assert_fail: () => { throw new Error('assert failed'); },
      __cxa_throw: () => { throw new Error('C++ exception'); },
      abort: () => { throw new Error('abort'); },
      emscripten_date_now: () => Date.now(),
      emscripten_memcpy_js: (dest, src, num) => heapU8.copyWithin(dest, src, src + num),
      emscripten_resize_heap: (requestedSize) => {
        const pages = Math.ceil((requestedSize - wasmMemory.buffer.byteLength) / 65536);
        if (pages > 0) {
          try { wasmMemory.grow(pages); } catch (e) { return 0; }
          updateHeapViews();
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

  const instance = await WebAssembly.instantiate(wasmModule, imports);
  wasmExports = instance.exports;
  wasmMemory = wasmExports.memory;
  updateHeapViews();
  if (wasmExports.__wasm_call_ctors) wasmExports.__wasm_call_ctors();
}

// Copy `count` frames of each channel (from `pos`) into the wasm input buffer,
// channel-sequential with stride `count`.
function writeInput(channelData, pos, count, channels, inPtr) {
  const base = inPtr >> 2;
  for (let c = 0; c < channels; c++) {
    heapF32.set(channelData[c].subarray(pos, pos + count), base + c * count);
  }
}

function stretch(channelData, sampleRate, timeRatio, pitchScale, options) {
  const channels = channelData.length;
  const inLen = channelData[0].length;

  const rb = wasmExports.rb_new(sampleRate, channels, options, timeRatio, pitchScale);
  wasmExports.rb_set_expected_input_duration(rb, inLen);

  const inPtr = wasmExports.rb_alloc(channels * BLOCK);
  const outPtr = wasmExports.rb_alloc(channels * BLOCK);

  // Study pass — lets offline mode analyse the whole signal for best quality.
  for (let pos = 0; pos < inLen; pos += BLOCK) {
    const n = Math.min(BLOCK, inLen - pos);
    writeInput(channelData, pos, n, channels, inPtr);
    wasmExports.rb_study(rb, inPtr, n, channels, pos + n >= inLen ? 1 : 0);
  }

  const outChunks = [];
  for (let c = 0; c < channels; c++) outChunks.push([]);
  let outTotal = 0;

  const drain = () => {
    let avail = wasmExports.rb_available(rb);
    while (avail > 0) {
      const n = Math.min(avail, BLOCK);
      wasmExports.rb_retrieve(rb, outPtr, n, channels);
      const base = outPtr >> 2;
      for (let c = 0; c < channels; c++) {
        outChunks[c].push(heapF32.slice(base + c * n, base + c * n + n));
      }
      outTotal += n;
      avail = wasmExports.rb_available(rb);
    }
  };

  // Process pass — feed all input, retrieving output as it becomes available.
  for (let pos = 0; pos < inLen; pos += BLOCK) {
    const n = Math.min(BLOCK, inLen - pos);
    writeInput(channelData, pos, n, channels, inPtr);
    wasmExports.rb_process(rb, inPtr, n, channels, pos + n >= inLen ? 1 : 0);
    drain();
  }
  drain(); // flush any tail after the final block

  wasmExports.rb_free(inPtr);
  wasmExports.rb_free(outPtr);
  wasmExports.rb_delete(rb);

  // Concatenate the per-channel chunks into contiguous output arrays.
  const result = [];
  for (let c = 0; c < channels; c++) {
    const merged = new Float32Array(outTotal);
    let off = 0;
    for (const chunk of outChunks[c]) { merged.set(chunk, off); off += chunk.length; }
    result.push(merged);
  }
  return result;
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      await instantiate(msg.wasmModule);
      self.postMessage({ type: 'ready' });
      return;
    }
    if (msg.type === 'stretch') {
      const out = stretch(msg.channelData, msg.sampleRate, msg.timeRatio, msg.pitchScale, msg.options);
      self.postMessage(
        { type: 'result', id: msg.id, channelData: out, sampleRate: msg.sampleRate },
        out.map((a) => a.buffer)
      );
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg && msg.id, message: err.message });
  }
};
