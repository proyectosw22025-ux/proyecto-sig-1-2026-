import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // En desarrollo nativo (npm run dev) el frontend usa la ruta relativa
  // /graphql/, y este proxy la reenvía al backend Django en el puerto 8080
  // (en Docker esto lo hace Nginx; ver frontend/nginx.conf).
  server: {
    proxy: {
      '/graphql': 'http://localhost:8080',
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Visor SIG - Transporte Público Santa Cruz',
        short_name: 'Visor SIG',
        description: 'Paradas y líneas del transporte público de Santa Cruz de la Sierra sobre un mapa interactivo.',
        theme_color: '#3b82f6',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        lang: 'es',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cachea el app shell (JS/CSS/HTML) automáticamente
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        runtimeCaching: [
          {
            // Tiles del mapa (OSM, Carto, Esri): disponibles offline tras la primera carga
            urlPattern: /^https:\/\/.*\.(?:tile\.openstreetmap\.org|basemaps\.cartocdn\.com|server\.arcgisonline\.com)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 1000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Respuestas del backend GraphQL: red primero, cae a caché si no hay conexión
            urlPattern: /^http:\/\/localhost:8080\/graphql\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'graphql-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false, // El SW solo se activa en build de producción (preview/deploy)
      },
    }),
  ],
})
