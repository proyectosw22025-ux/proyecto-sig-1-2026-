// Servicio de ruteo PEATONAL: calcula el camino a pie entre dos puntos usando
// el servidor OSRM de OpenStreetMap-DE con perfil 'foot'. Sin API key.
// A diferencia del perfil vehicular, NO respeta sentidos de circulación
// (contrarutas), porque una persona caminando puede ir en cualquier dirección.

const OSRM_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

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
