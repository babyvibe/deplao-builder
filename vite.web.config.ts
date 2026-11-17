import { defineConfig, mergeConfig } from 'vite';
import desktop from './vite.config';

export default mergeConfig(desktop, defineConfig({
  base: '/',
  define: { __CHANNELS_ONLY__: 'true' },
  build: { outDir: 'dist-web' },
  plugins: [{
    name: 'deplao-browser-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) { return html.replace('/src/ui/main.tsx', '/src/ui/platform/browser.ts'); },
    },
  }],
}));
