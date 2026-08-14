import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The Overview landing (issue #385, charter amendment decision 7): React + Vite
// compiled to ONE self-contained HTML file — no external assets, no CDN, nothing
// fetched off-machine at runtime. scripts/build-dashboard.mjs runs this build and
// then inlines the emitted HTML into src/dashboard-app.mjs, which is what the
// daemon serves (and what the esbuild SEA bundle carries).
//
// The daemon's CSP for this page is
//   default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
//   connect-src 'self'; img-src 'self' data:
// so the build must emit inline <script>/<style> only and reach the network
// exclusively through same-origin /api fetches.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  // `npm run dashboard:dev` for live-tweak sessions: the page is served by Vite
  // and its /api calls are proxied to a locally running daemon.
  server: {
    port: 5273,
    proxy: { '/api': process.env.MODELDECK_DEV_API || 'http://127.0.0.1:3867' },
  },
});
