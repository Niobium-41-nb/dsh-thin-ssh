import { defineConfig } from 'tsdown'

/** One host-only artifact: `lib/index.js`, compiled from `lib/types/index.js`. */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
