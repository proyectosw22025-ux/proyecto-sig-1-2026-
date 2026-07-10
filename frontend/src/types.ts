export interface RouteType {
  id: string;
  name: string;
  color: string;
  geomGeojson?: string;  // Cadena JSON de la geometría del trazado (camelCase de GraphQL)
  sentido?: string;
  stopIds?: string[];    // IDs de las paradas que pertenecen a esta ruta
}

// Parada mínima usada en los tramos del viaje (no trae la lista de líneas)
export interface StopRef {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface TripLeg {
  route: RouteType;
  boardStop: StopRef;      // dónde subir
  alightStop: StopRef;     // dónde bajar
  rideDistanceM: number;
  rideMinutes: number;
}

export interface TripOption {
  transfers: number;       // 0 = directa, 1 = un transbordo
  legs: TripLeg[];         // 1 tramo (directa) o 2 (con transbordo)
  walkDistanceM: number;   // total a pie
  walkMinutes: number;
  rideMinutes: number;
  totalMinutes: number;
  exact: boolean;          // false = aproximación (fallback), ninguna línea sirve bien
}

export interface StopType {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance?: number | null; // Distancia en metros (solo en parada más cercana)
  routes: RouteType[];
}
