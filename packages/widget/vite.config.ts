import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/auto-init.ts'),
      name: 'XSpaceWidget',
      formats: ['umd', 'es'],
      fileName: (format) =>
        format === 'es' ? 'xspace-widget.esm.js' : 'xspace-widget.umd.js',
    },
    rollupOptions: {
      // bundle everything including socket.io-client for self-contained UMD
      external: [],
    },
    minify: 'esbuild',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
