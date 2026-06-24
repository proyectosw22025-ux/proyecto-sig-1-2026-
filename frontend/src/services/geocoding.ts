// Geocodificador: convierte una dirección de texto en coordenadas usando
// Nominatim (servicio gratuito de OpenStreetMap). No requiere API key.
// Política de uso: bajo volumen y un User-Agent/Referer identificable; para un
// proyecto académico esto es suficiente.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Acotamos la búsqueda al área de Santa Cruz de la Sierra (viewbox: oeste,norte,este,sur)
const SCZ_VIEWBOX = '-63.35,-17.65,-63.00,-18.05';

export interface GeocodeResult {
  label: string;       // Nombre legible del lugar encontrado
  latitude: number;
  longitude: number;
}

export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const params = new URLSearchParams({
    q: `${trimmed}, Santa Cruz de la Sierra, Bolivia`,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '0',
    countrycodes: 'bo',
    viewbox: SCZ_VIEWBOX,
    bounded: '1', // Restringe los resultados al viewbox
  });

  const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: { 'Accept-Language': 'es' },
  });

  if (!response.ok) {
    throw new Error(`Nominatim respondió ${response.status}`);
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const best = results[0];
  return {
    label: best.display_name,
    latitude: parseFloat(best.lat),
    longitude: parseFloat(best.lon),
  };
}
