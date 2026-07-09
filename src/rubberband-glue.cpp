#include <emscripten.h>
#include "rubberband/rubberband-c.h"
#include <cstdlib>

// Offline time-stretching / pitch-shifting glue. Unlike real-time mode, offline
// mode performs automatic start padding and latency compensation, so the caller
// just feeds all input (optionally studies it first) and retrieves all output.
// Uses channel-sequential memory layout (all samples for ch0, then ch1, ...).

extern "C" {

EMSCRIPTEN_KEEPALIVE
RubberBandState rb_new(unsigned int sampleRate, unsigned int channels,
                       int options, double timeRatio, double pitchScale) {
    // Force offline mode (clear the real-time bit) and single-threaded operation
    // (no pthreads in this WASM build).
    options &= ~RubberBandOptionProcessRealTime;
    options |= RubberBandOptionThreadingNever;
    return rubberband_new(sampleRate, channels, (RubberBandOptions)options,
                          timeRatio, pitchScale);
}

EMSCRIPTEN_KEEPALIVE
void rb_delete(RubberBandState st) { rubberband_delete(st); }

EMSCRIPTEN_KEEPALIVE
void rb_set_expected_input_duration(RubberBandState st, unsigned int samples) {
    rubberband_set_expected_input_duration(st, samples);
}

EMSCRIPTEN_KEEPALIVE
void rb_study(RubberBandState st, float* input, unsigned int samples,
              unsigned int channels, int final_flag) {
    float** ptrs = (float**)malloc(channels * sizeof(float*));
    for (unsigned int c = 0; c < channels; c++) ptrs[c] = input + c * samples;
    rubberband_study(st, (const float* const*)ptrs, samples, final_flag);
    free(ptrs);
}

EMSCRIPTEN_KEEPALIVE
void rb_process(RubberBandState st, float* input, unsigned int samples,
                unsigned int channels, int final_flag) {
    float** ptrs = (float**)malloc(channels * sizeof(float*));
    for (unsigned int c = 0; c < channels; c++) ptrs[c] = input + c * samples;
    rubberband_process(st, (const float* const*)ptrs, samples, final_flag);
    free(ptrs);
}

EMSCRIPTEN_KEEPALIVE
int rb_available(RubberBandState st) { return rubberband_available(st); }

EMSCRIPTEN_KEEPALIVE
unsigned int rb_retrieve(RubberBandState st, float* output,
                         unsigned int samples, unsigned int channels) {
    float** ptrs = (float**)malloc(channels * sizeof(float*));
    for (unsigned int c = 0; c < channels; c++) ptrs[c] = output + c * samples;
    unsigned int ret = rubberband_retrieve(st, ptrs, samples);
    free(ptrs);
    return ret;
}

EMSCRIPTEN_KEEPALIVE
float* rb_alloc(unsigned int floats) {
    return (float*)malloc(floats * sizeof(float));
}

EMSCRIPTEN_KEEPALIVE
void rb_free(float* ptr) { free(ptr); }

}
