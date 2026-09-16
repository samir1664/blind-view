import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * `getUserMedia` only exists in a secure context. `localhost` counts as one,
 * but a LAN address such as http://192.168.1.20:5173 does not — which is
 * exactly how you open the app on a phone. Without HTTPS the camera can never
 * start there, so `npm run dev:https` serves a self-signed certificate.
 */
const useHttps = process.env.HTTPS === '1';

export default defineConfig({
  plugins: [
    react(),
    ...(useHttps ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Blind View',
        short_name: 'Blind View',
        description: 'Hear what the camera sees.',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // The TF.js model shards are large; cache them so the hazard layer
        // keeps working offline after the first successful load.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // The ONNX runtime (14 MB) and depth model (26 MB) are deliberately
        // NOT precached: forcing a 40 MB download before first use would make
        // the app feel broken on mobile data. They are cached on first use
        // instead, after which the terrain layer works offline too.
        globIgnores: ['**/ort/**', '**/models/**'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/(storage\.googleapis\.com|tfhub\.dev)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tfjs-models',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }: { url: URL }) =>
              url.pathname.startsWith('/models/') ||
              url.pathname.startsWith('/ort/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'depth-runtime',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // onnxruntime-web ships two flavours of its WASM entry. The default inlines
  // the 14 MB binary as a bundled asset; this condition selects the variant
  // that loads it from `ort.env.wasm.wasmPaths` instead, so we serve exactly
  // one copy from /ort/ and the service worker can cache it on first use.
  resolve: {
    conditions: [
      'onnxruntime-web-use-extern-wasm',
      'module',
      'browser',
      'development|production',
    ],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    // Exposes the dev server on your LAN so you can open it on a phone.
    host: true,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PORT || 8787}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          tfjs: [
            '@tensorflow/tfjs-core',
            '@tensorflow/tfjs-converter',
            '@tensorflow/tfjs-backend-webgl',
            '@tensorflow/tfjs-backend-cpu',
            '@tensorflow-models/coco-ssd',
          ],
        },
      },
    },
  },
});
