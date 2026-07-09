export interface RouteType {
  id: string;
  name: string;
  color: string;
  geomGeojson?: string;  // Cadena JSON de la geometría del trazado (camelCase de GraphQL)
  sentido?: string;
  stopIds?: string[];    // IDs de las paradas que pertenecen a esta ruta
}

export interface RouteMatchType {
  route: RouteType;
  exact: boolean;          // false = aproximación (fallback), no hay línea directa real
  distanceOriginM: number; // metros del trazado al origen
  distanceDestM: number;   // metros del trazado al destino
}

export interface StopType {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance?: number | null; // Distancia en metros (solo en parada más cercana)
  routes: RouteType[];
}
