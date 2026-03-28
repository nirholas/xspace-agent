import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  root: resolve(__dirname),
  resolve: {
    alias: {
      '@agent-voice-chat/vue': resolve(__dirname, '../src/index.ts'),
      '@agent-voice-chat/core': resolve(__dirname, '../../core/src/index.ts'),
    },
  },
  server: { port: 5174 },
});
