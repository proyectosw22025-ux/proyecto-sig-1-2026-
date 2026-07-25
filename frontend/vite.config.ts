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
      // El registro se hace a mano en src/main.tsx para poder comprobar si hay
      // una versión nueva de forma periódica (ver allí el porqué).
      injectRegister: false,
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
        // Android (y las herramientas que empaquetan la PWA como APK) exigen
        // PNG de 192 y 512; con solo SVG rechazan el manifest. El "maskable"
        // lleva mas margen porque el sistema lo recorta a un circulo.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
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
          // NOTA: las respuestas de /graphql/ NO se cachean. El cliente consulta
          // la API por POST y la Cache API del navegador solo admite GET
          // (`Cache.put()` rechaza cualquier otro método), así que una regla de
          // runtimeCaching aquí nunca llegaría a guardar nada. Consecuencia: sin
          // conexión carga la interfaz y los tiles del mapa, pero no las paradas
          // ni las líneas. Para servirlas offline habría que guardarlas por
          // nuestra cuenta (p. ej. en IndexedDB) al recibirlas.
        ],
      },
      devOptions: {
        enabled: false, // El SW solo se activa en build de producción (preview/deploy)
      },
    }),
  ],
})
