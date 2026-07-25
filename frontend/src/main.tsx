import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

// Cada cuánto se pregunta al servidor si hay una versión nueva desplegada.
const INTERVALO_COMPROBACION = 60 * 60 * 1000 // 1 hora

// Registro del service worker. El plugin está en modo `autoUpdate`: en cuanto
// detecta una versión nueva la instala y recarga la app sola.
//
// El navegador solo busca actualizaciones al arrancar la app, y el APK que se
// distribuye suele quedarse abierto en segundo plano durante días, así que un
// cambio recién desplegado podía tardar en aparecer. Por eso se registra a mano
// y se fuerza la comprobación al volver a la app, al recuperar conexión y cada
// hora.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return

    // Sin conexión `update()` rechaza; no es un error que deba propagarse.
    const comprobar = () => { registration.update().catch(() => {}) }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') comprobar()
    })
    window.addEventListener('online', comprobar)
    setInterval(comprobar, INTERVALO_COMPROBACION)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
