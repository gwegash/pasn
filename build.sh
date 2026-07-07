#!/bin/bash
set -e

EMSDK_DIR="/home/greg/git/emsdk"
source "$EMSDK_DIR/emsdk_env.sh"

RUBBERBAND_DIR="./rubberband"
SRC_DIR="./src"
BUILD_DIR="./build"

mkdir -p "$BUILD_DIR"

echo "Compiling rubberband + glue to WASM..."

em++ -O2 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_rb_new","_rb_delete","_rb_set_pitch_scale","_rb_get_samples_required","_rb_get_preferred_start_pad","_rb_get_start_delay","_rb_set_max_process_size","_rb_process","_rb_available","_rb_retrieve","_rb_reset","_rb_alloc","_rb_free","_malloc","_free"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s ENVIRONMENT='web' \
  -s NO_FILESYSTEM=1 \
  -s DISABLE_EXCEPTION_CATCHING=1 \
  -DLACK_SINCOS=1 \
  -I"$RUBBERBAND_DIR" \
  -I"$RUBBERBAND_DIR/src" \
  "$RUBBERBAND_DIR/single/RubberBandSingle.cpp" \
  "$SRC_DIR/rubberband-glue.cpp" \
  -o "$BUILD_DIR/rubberband-wasm.js"

echo "Copying processor.js..."

cp "$SRC_DIR/rubberband-processor.js" "$BUILD_DIR/processor.js"

echo "Build complete: $BUILD_DIR/rubberband-wasm.wasm and $BUILD_DIR/processor.js"
