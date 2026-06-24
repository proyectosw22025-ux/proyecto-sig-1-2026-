// Servicio de ruteo: calcula el camino por CALLES entre dos puntos usando OSRM
// (Open Source Routing Machine), servidor público y gratuito de OpenStreetMap.
// Sin API key. Se usa para dibujar la ruta real del usuario hasta la parada,
// en vez de una recta que cruza por encima de las manzanas.
//
// Nota: el servidor demo público de OSRM expone el perfil 'driving' (calles
// vehiculares). Para una caminata corta a la parada es una aproximación válida
// y visualmente correcta (sigue la red de calles).

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

export interface StreetRoute {
  // Polilínea en formato Leaflet [lat, lng]
  path: [number, number][];
  // Distancia real del recorrido por calles, en metros
  distanceMeters: number;
}

/**
 * Devuelve el recorrido por calles entre `from` y `to` (ambos como [lat, lng]),
 * o `null` si el servicio de ruteo no responde (el llamador hace fallback a recta).
 */
export async function getStreetRoute(
  from: [number, number],
  to: [number, number],
): Promise<StreetRoute | null> {
  // OSRM espera coordenadas como lng,lat
  const coords = `${from[1]},${from[0]};${to[1]},${to[0]}`;
  const url = `${OSRM_URL}/${coords}?overview=full&geometries=geojson`;

  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json();
  if (data.code !== 'Ok' || !Array.isArray(data.routes) || data.routes.length === 0) {
    return null;
  }

  const route = data.routes[0];
  // GeoJSON entrega [lng, lat]; Leaflet necesita [lat, lng]
  const path: [number, number][] = route.geometry.coordinates.map(
    (c: [number, number]) => [c[1], c[0]],
  );

  return { path, distanceMeters: route.distance };
}
