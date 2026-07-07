// Produces build/pitch-shift-buffer-source.bundled.js — a single self-contained
// ESM file with the worklet source and wasm binary inlined, so it drops into any
// bundler (esbuild, Vite, webpack) or a CDN with zero asset setup.
//
// Run after `npm run build` (needs build/processor.js and build/rubberband-wasm.wasm).
import { build } from 'esbuild';
import { readFileSync } from 'fs';

const processorSrc = readFileSync('./build/processor.js', 'utf8');
const wasmBase64 = readFileSync('./build/rubberband-wasm.wasm').toString('base64');

await build({
  entryPoints: ['src/PitchShiftBufferSource.js'],
  bundle: true,
  format: 'esm',
  outfile: 'build/pitch-shift-buffer-source.bundled.js',
  define: {
    PSB_INLINE_PROCESSOR: JSON.stringify(processorSrc),
    PSB_INLINE_WASM: JSON.stringify(wasmBase64),
  },
});

console.log('Bundled -> build/pitch-shift-buffer-source.bundled.js');
