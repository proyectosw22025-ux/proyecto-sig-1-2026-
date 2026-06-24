export interface RouteType {
  id: string;
  name: string;
  color: string;
  geom_geojson: string; // Cadena JSON de la geometría del trazado
}

export interface StopType {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance?: number | null; // Distancia en metros (solo en parada más cercana)
  routes: RouteType[];
}
