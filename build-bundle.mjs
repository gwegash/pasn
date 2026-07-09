// Produces build/timestretcher.bundled.js — a single self-contained ESM file
// with the worker source and wasm binary inlined, so it drops into any bundler
// (esbuild, Vite, webpack) or a CDN with zero asset setup.
//
// Run after `npm run build` (needs build/rubberband-wasm.wasm).
import { build } from 'esbuild';
import { readFileSync } from 'fs';

const workerSrc = readFileSync('./src/timestretch-worker.js', 'utf8');
const wasmBase64 = readFileSync('./build/rubberband-wasm.wasm').toString('base64');

await build({
  entryPoints: ['src/Timestretcher.js'],
  bundle: true,
  format: 'esm',
  outfile: 'build/timestretcher.bundled.js',
  define: {
    PSB_INLINE_WORKER: JSON.stringify(workerSrc),
    PSB_INLINE_WASM: JSON.stringify(wasmBase64),
  },
});

console.log('Bundled -> build/timestretcher.bundled.js');
