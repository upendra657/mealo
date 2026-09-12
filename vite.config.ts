import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * SQLite's OPFS VFS needs the page to be cross-origin isolated, which means
 * these two headers. They apply to `vite dev` and `vite preview`; when you
 * deploy, the host has to send them too or the app silently falls back to an
 * in-memory database. The status bar reports which mode is live — watch it.
 *
 * Side effect worth knowing: with COEP require-corp, cross-origin subresources
 * need CORP/CORS headers of their own. That rules out casually dropping in a
 * Google Fonts link. It does not affect fetch() to the model provider.
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Stamped into the bundle so the running build is identifiable from the UI.
// PWAs cache aggressively and iOS is especially sticky about service workers;
// without this, "is the fix deployed" and "is the fix working" look identical.
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Mealo',
        short_name: 'Mealo',
        description:
          'Local-first health tracking with scoped AI agents. Your data stays on your device.',
        theme_color: '#0E6B5C',
        background_color: '#FBFCFA',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The sqlite wasm binary is large; keep it cached for offline use.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
});
