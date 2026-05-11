import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const pkg = require('./package.json');
const isProd = process.env.NODE_ENV === 'production' || process.env.BUILD_TARGET === 'production';

/**
 * Load javascript-obfuscator plugin đồng bộ qua require() — chỉ production.
 * Dùng require() để tránh async defineConfig (TypeScript không nhận async factory).
 */
function loadObfuscatorPlugin(): any[] {
  if (!isProd) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('vite-plugin-javascript-obfuscator');
    const factory: (opts: any) => any = mod.default ?? mod;
    return [
      factory({
        options: {
          // ── Bảo vệ cơ bản ───────────────────────────────────────────────
          compact: true,
          selfDefending: false,       // tắt: có thể gây lỗi strict-mode
          disableConsoleOutput: true, // xóa toàn bộ console.* còn sót
          debugProtection: false,     // tắt: gây lag khi debug tool mở

          // ── String obfuscation ──────────────────────────────────────────
          stringArray: true,
          stringArrayEncoding: ['rc4'],  // mã hóa string literals bằng RC4
          stringArrayThreshold: 0.8,     // 80% strings được mã hóa
          stringArrayRotate: true,
          stringArrayShuffle: true,
          splitStrings: true,
          splitStringsChunkLength: 5,

          // ── Identifier renaming ─────────────────────────────────────────
          identifierNamesGenerator: 'hexadecimal', // biến → _0x12ab34
          renameGlobals: false,        // tắt: dễ break global vars
          renameProperties: false,     // tắt: dễ break React props

          // ── Control flow (TẮT — bật làm chậm 1.5-3x) ──────────────────
          controlFlowFlattening: false,
          deadCodeInjection: false,
          numbersToExpressions: false,

          // ── Source map ──────────────────────────────────────────────────
          sourceMap: false,
          transformObjectKeys: false,  // tắt: dễ break React component props
        },
        // Chỉ obfuscate chunk code của mình, bỏ qua vendor (node_modules)
        include: [/dist\/assets\/index-.*\.js$/],
        exclude: [/dist\/assets\/vendor-.*\.js$/, /node_modules/],
      }),
    ];
  } catch {
    console.warn('⚠ vite-plugin-javascript-obfuscator not found, skipping obfuscation');
    return [];
  }
}

const config: UserConfig = {
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Polyfill process.env cho renderer (browser không có process)
    'process.env.NODE_ENV':    JSON.stringify(isProd ? 'production' : 'development'),
    'process.env.BUILD_TARGET': JSON.stringify(process.env.BUILD_TARGET ?? (isProd ? 'production' : 'development')),
  },
  plugins: [
    react(),
    ...loadObfuscatorPlugin(),
  ],
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: isProd ? ('terser' as const) : ('esbuild' as const),
    sourcemap: false,
    terserOptions: isProd ? {
      compress: {
        drop_console: true,
        drop_debugger: true,
        pure_funcs: [
          'console.log', 'console.warn', 'console.info',
          'console.debug', 'console.trace', 'console.dir',
        ],
        passes: 2,
        dead_code: true,
      },
      mangle: {
        toplevel: true,
      },
      format: {
        comments: false,
      },
    } : undefined,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        // Tách vendor chunk để obfuscator không xử lý node_modules
        manualChunks(id: string) {
          if (id.includes('node_modules')) return 'vendor';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/index-[hash].js',
      },
    },
  },
  server: {
    port: 5713,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/ui'),
    },
  },
  optimizeDeps: {
    exclude: ['electron', 'sql.js'],
  },
};

export default defineConfig(config);
