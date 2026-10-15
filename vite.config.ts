import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * SQLite's OPFS VFS needs the page to be cross-origin isolated, which means
 * these two headers. They apply to `vite dev` and `vite preview`; when you
 * deploy, the host has to send them too or the app silently falls back to an
 * in-memory database. Dev's This phone card says so when it happens — watch it.
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

/**
 * The public demo is its own build (`npm run build:demo`): the same app with
 * a made-up person in it, at its own address. It installs under its own name
 * so that a phone with both on the Home Screen shows which is which.
 */
const DEMO = process.env.VITE_DEMO === '1';

export default defineConfig({
  // __DEMO__ is a literal true or false by the time the bundler sees it, so
  // in the real build `if (__DEMO__)` is `if (false)` and the demo's person,
  // which sits behind it, is dropped whole. Read through import.meta.env the
  // branch survived to the minifier and its file was shipped, unused, to
  // every phone's offline cache.
  define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP), __DEMO__: JSON.stringify(DEMO) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The two 512 px icons are left out of the offline cache. The phone's
      // own installer fetches them once, when the app is added to the Home
      // Screen; the running app never draws them. Cached, they added 450 kB
      // to what every phone downloads on every update.
      // Nothing named here: the cache's own pattern below already takes every
      // png but those two, and naming three of them as well put each in the
      // cache twice (97 kB, found 15 Oct 2026).
      includeAssets: [],
      includeManifestIcons: false,
      manifest: {
        name: DEMO ? 'Mealo demo' : 'Mealo',
        short_name: DEMO ? 'Mealo demo' : 'Mealo',
        description:
          'Local-first health tracking with scoped AI agents. Your data stays on your device.',
        // Both track --ink in styles.css, the page's own background. They
        // are what Android paints before any of our CSS exists: theme_color
        // tints the status bar, background_color is the splash behind the
        // icon. Left at the old light palette they made the app open with a
        // white flash and a green status bar it never wears again.
        theme_color: '#0a0c0b',
        background_color: '#0a0c0b',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          // Its own file, not icon-512 again. Android cuts a maskable icon
          // to a circle and keeps only the middle four fifths; in Upendra's
          // drawing the fork's tines reach past that, and lost their tips.
          // Here the same drawing is set smaller on its own black ground.
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The sqlite wasm binary is large; keep it cached for offline use.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,wasm,woff2}'],
        // See includeAssets above: the installer's icons, not the app's.
        globIgnores: ['**/icon-512.png', '**/icon-maskable-512.png'],
        // Reminders. The generated worker caches and nothing more; this adds
        // the two listeners that turn an empty push into a notification
        // (public/push-sw.js). Pulled in rather than switching the plugin to
        // a hand-written worker: the caching worker is what every phone
        // already runs, and iOS is slow to let go of one.
        importScripts: ['push-sw.js'],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
});
