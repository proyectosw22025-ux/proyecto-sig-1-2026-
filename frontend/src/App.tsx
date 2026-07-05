import { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
//import '/'
import { 
  Bus, 
  Search, 
  Navigation, 
  Moon, 
  Sun, 
  Compass, 
  MapPin, 
  Layers,
  Info,
  Trash2,
  X
} from 'lucide-react';
import { graphqlService } from './services/graphql';
import { geocodeAddress } from './services/geocoding';
import { getStreetRoute } from './services/routing';
import type { RouteType, StopType } from './types';

// Solución para iconos de Leaflet por defecto que se rompen con Vite
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [stops, setStops] = useState<StopType[]>([]);
  const [routes, setRoutes] = useState<RouteType[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'stops' | 'routes'>('stops');
  const [selectedStop, setSelectedStop] = useState<StopType | null>(null);
  
  // Estado para visibilidad de rutas individuales { [routeId]: boolean }
  const [visibleRoutes, setVisibleRoutes] = useState<Record<string, boolean>>({});

  // Visibilidad por parada { [stopId]: boolean } — igual que las líneas
  const [visibleStops, setVisibleStops] = useState<Record<string, boolean>>({});
  
  // Planificador: punto de ORIGEN (marcado en el mapa) y DESTINO
  const [originCoords, setOriginCoords] = useState<[number, number] | null>(null);
  const [destCoords, setDestCoords] = useState<[number, number] | null>(null);
  // Qué fija el próximo click en el mapa: el origen o el destino
  const [clickMode, setClickMode] = useState<'origin' | 'destination'>('origin');
  const [closestStop, setClosestStop] = useState<StopType | null>(null);

  // Resultado del planificador: líneas que conectan origen y destino
  const [tripRoutes, setTripRoutes] = useState<RouteType[] | null>(null);
  const [tripLoading, setTripLoading] = useState(false);
  const [tripError, setTripError] = useState<string | null>(null);

  // Geocodificador (dirección -> coordenada) usado para el destino
  const [addressQuery, setAddressQuery] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);

  // Mostrar/ocultar la caja de instrucciones del mapa
  const [showInstructions, setShowInstructions] = useState(true);

  const mapRef = useRef<L.Map | null>(null);
  const stopsClusterGroupRef = useRef<L.LayerGroup | null>(null);
  const routesLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const routeStopsLayerRef = useRef<L.LayerGroup | null>(null);
  const stopMarkersRef = useRef<Record<string, L.Marker>>({});
  const highlightedRouteIdRef = useRef<string | null>(null);
  // Espejo de visibleRoutes para leer el estado actual desde callbacks de Leaflet
  const visibleRoutesRef = useRef<Record<string, boolean>>({});
  const originMarkerRef = useRef<L.Marker | null>(null);
  const destMarkerRef = useRef<L.Marker | null>(null);
  const closestPathRef = useRef<L.Polyline | null>(null);
  // Espejo de clickMode para el handler de click del mapa (evita closure obsoleto)
  const clickModeRef = useRef<'origin' | 'destination'>('origin');

  // Referencias a los objetos de trazados de líneas en el mapa para poder resaltarlas
  const lineObjectsRef = useRef<Record<string, L.GeoJSON>>({});

  // 1. Inicialización del Mapa
  useEffect(() => {
    // Creamos el mapa centrado en Santa Cruz de la Sierra
    const map = L.map('map', {
      center: [-17.78629, -63.18117],
      zoom: 13,
      zoomControl: false // Quitamos los controles por defecto para ubicarlos abajo-derecha
    });

    mapRef.current = map;

    // Agregar control de zoom abajo-derecha
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Definición de las Capas Base
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    });

    const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    });

    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri'
    });

    // Añadir capa base por defecto (oscura)
    darkLayer.addTo(map);

    // Guardamos las capas base en el mapa para cambiarlas dinámicamente
    // @ts-ignore
    map.baseLayers = {
      light: osmLayer,
      dark: darkLayer,
      satellite: satelliteLayer
    };

    // Capas de datos
    // @ts-ignore
    // Sin agrupamiento: cada parada se ve como su propio punto (no clusters).
    // La capa está siempre en el mapa; controlamos qué paradas se ven dibujando
    // solo las marcadas como visibles (igual que las líneas).
    const clusterGroup = L.layerGroup();
    map.addLayer(clusterGroup);
    stopsClusterGroupRef.current = clusterGroup;

    const routesGroup = L.layerGroup();
    map.addLayer(routesGroup);
    routesLayerGroupRef.current = routesGroup;

    // Capa para resaltar las paradas de la ruta seleccionada (encima del cluster)
    const routeStopsGroup = L.layerGroup();
    map.addLayer(routeStopsGroup);
    routeStopsLayerRef.current = routeStopsGroup;

    // Escuchar clicks en el mapa para buscar parada cercana desde el punto clickeado
    map.on('click', (e: L.LeafletMouseEvent) => {
      handleMapClick(e.latlng.lat, e.latlng.lng);
    });

    // Cargar datos del backend
    fetchData();

    return () => {
      map.remove();
    };
  }, []);

  // 2. Efecto para manejar el cambio de tema del mapa y de la UI
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    const map = mapRef.current;
    if (map) {
      // @ts-ignore
      const layers = map.baseLayers;
      if (layers) {
        if (theme === 'dark') {
          map.removeLayer(layers.light);
          map.addLayer(layers.dark);
        } else {
          map.removeLayer(layers.dark);
          map.addLayer(layers.light);
        }
      }
    }
  }, [theme]);

  // Mantener el espejo de visibleRoutes actualizado para los callbacks de Leaflet
  useEffect(() => {
    visibleRoutesRef.current = visibleRoutes;
  }, [visibleRoutes]);

  // Carga inicial de datos desde GraphQL
  const fetchData = async () => {
    try {
      const stopsData = await graphqlService.getStops();
      const routesData = await graphqlService.getRoutes();

      setStops(stopsData);
      setRoutes(routesData);

      // Modo on-demand: por defecto NINGUNA línea ni parada se dibuja (evita el
      // caos visual). Se muestran al hacer click, buscar o con "Mostrar todas".
      const routeVis: Record<string, boolean> = {};
      routesData.forEach((r: RouteType) => { routeVis[r.id] = false; });
      setVisibleRoutes(routeVis);

      const stopVis: Record<string, boolean> = {};
      stopsData.forEach((s: StopType) => { stopVis[s.id] = false; });
      setVisibleStops(stopVis);

      plotStops(stopsData, stopVis);
      plotRoutes(routesData, routeVis);
    } catch (error) {
      console.error("Error cargando datos del backend:", error);
    }
  };

  // Dibujar paradas (Stops) con Clusters
  // Construye el contenido del popup de una parada (nombre, líneas y botón).
  // El botón alterna entre "Seleccionar parada" (muestra sus rutas) y
  // "Deseleccionar parada" (las quita); su estado se ajusta al abrir el popup.
  const buildStopPopup = (stop: StopType): HTMLElement => {
    const el = document.createElement('div');
    el.style.fontFamily = 'var(--font-body)';
    el.style.padding = '5px';

    const routesTags = stop.routes.map(r =>
      `<span class="route-tag" style="background-color: ${r.color}; margin-right: 4px; padding: 2px 6px; border-radius: 4px; color: white; font-size: 10px; font-weight: bold; display: inline-block;">
        ${r.name.split(' ')[1] || r.name}
       </span>`
    ).join('');

    el.innerHTML = `
      <h4 style="font-family: var(--font-title); font-weight: 700; font-size: 14px; margin-bottom: 6px; color: var(--text-primary);">${stop.name}</h4>
      <p style="font-size: 11px; color: var(--text-secondary); margin-bottom: 10px;">Parada de transporte público</p>
      <div style="margin-bottom: 12px;">${routesTags || '<span style="font-size: 11px; color: var(--text-muted);">Sin líneas asignadas</span>'}</div>
    `;

    const btn = document.createElement('button');
    btn.className = 'stop-popup-toggle';
    btn.style.cssText = 'color: white; border: none; padding: 6px 12px; border-radius: 8px; font-size: 11px; font-weight: 600; cursor: pointer; width: 100%;';
    el.appendChild(btn);
    return el;
  };

  // ¿Están dibujadas en el mapa las rutas de esta parada? (lee el estado actual)
  const stopRoutesShown = (stop: StopType): boolean =>
    routes.some((r) => (r.stopIds ?? []).includes(stop.id) && visibleRoutesRef.current[r.id]);

  // Ajusta el botón del popup al abrirse: "Seleccionar" / "Deseleccionar"
  const configureStopPopupButton = (stop: StopType, marker: L.Marker) => {
    const popupEl = marker.getPopup()?.getElement();
    const btn = popupEl?.querySelector('.stop-popup-toggle') as HTMLButtonElement | null;
    if (!btn) return;

    if (stopRoutesShown(stop)) {
      btn.textContent = 'Deseleccionar parada';
      btn.style.background = 'var(--danger, #ef4444)';
      btn.onclick = () => { hideStopRoutes(stop); marker.closePopup(); };
    } else {
      btn.textContent = 'Seleccionar parada';
      btn.style.background = 'var(--primary)';
      btn.onclick = () => { setSelectedStop(stop); showStopRoutes(stop); marker.closePopup(); };
    }
  };

  const plotStops = (stopsList: StopType[], visibility: Record<string, boolean>) => {
    const cluster = stopsClusterGroupRef.current;
    if (!cluster) return;

    cluster.clearLayers();
    stopMarkersRef.current = {};

    stopsList.forEach((stop) => {
      if (!visibility[stop.id]) return;  // solo las paradas marcadas como visibles

      const stopIcon = L.divIcon({
        className: 'custom-stop-icon',
        html: `
          <div style="
            background-color: var(--primary);
            width: 16px;
            height: 16px;
            border: 2px solid white;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            cursor: pointer;
          "></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      const marker = L.marker([stop.latitude, stop.longitude], { icon: stopIcon });
      marker.bindPopup(buildStopPopup(stop));
      // Configurar el botón (Seleccionar/Deseleccionar) cada vez que se abre
      marker.on('popupopen', () => configureStopPopupButton(stop, marker));
      marker.on('click', () => setSelectedStop(stop));
      cluster.addLayer(marker);
      stopMarkersRef.current[stop.id] = marker;
    });
  };

  // Dibujar líneas/rutas de micro (Polylines)
  const plotRoutes = (routesList: RouteType[], visibility: Record<string, boolean>) => {
    const group = routesLayerGroupRef.current;
    if (!group) return;

    group.clearLayers();
    lineObjectsRef.current = {};

    routesList.forEach((route) => {
      if (!visibility[route.id] || !route.geomGeojson) return;

      try {
        const geom = JSON.parse(route.geomGeojson);
        
        // Leaflet geoJSON dibuja la geometría directamente
        const geojsonLayer = L.geoJSON(geom, {
          style: {
            color: route.color,
            weight: 4,
            opacity: 0.85,
            lineCap: 'round',
            lineJoin: 'round'
          }
        });

        // Eventos en la línea de micro (resaltar al pasar el mouse)
        geojsonLayer.on('mouseover', function (e) {
          const layer = e.target;
          layer.setStyle({
            weight: 7,
            opacity: 1.0
          });
        });

        geojsonLayer.on('mouseout', function (e) {
          const layer = e.target;
          layer.setStyle({
            weight: 4,
            opacity: 0.85
          });
        });

        // Popup para la línea
        geojsonLayer.bindPopup(`
          <div style="font-family: var(--font-body);">
            <strong style="color: ${route.color}; font-size: 13px;">${route.name}</strong>
            <p style="font-size: 11px; margin-top: 4px; color: var(--text-secondary);">Ruta del sistema de micros de Santa Cruz</p>
          </div>
        `);

        group.addLayer(geojsonLayer);
        lineObjectsRef.current[route.id] = geojsonLayer;
      } catch (e) {
        console.error(`Error parseando geometría de la ruta ${route.name}:`, e);
      }
    });
  };

  // Conmutar visibilidad de una línea
  const toggleRouteVisibility = (route: RouteType) => {
    const nuevoVisible = !visibleRoutes[route.id];
    const updated = { ...visibleRoutes, [route.id]: nuevoVisible };
    setVisibleRoutes(updated);
    plotRoutes(routes, updated);

    if (nuevoVisible) {
      // Al mostrar la línea, resaltar sus paradas
      highlightRouteStops(route);
    } else if (highlightedRouteIdRef.current === route.id) {
      // Al ocultarla, quitar también sus paradas resaltadas
      routeStopsLayerRef.current?.clearLayers();
      highlightedRouteIdRef.current = null;
    }
  };

  // Alternar una línea de los resultados del planificador (Ver ruta / Ocultar ruta)
  const toggleTripRoute = (route: RouteType) => {
    if (visibleRoutes[route.id]) {
      const updated = { ...visibleRoutes, [route.id]: false };
      setVisibleRoutes(updated);
      plotRoutes(routes, updated);
      if (highlightedRouteIdRef.current === route.id) {
        routeStopsLayerRef.current?.clearLayers();
        highlightedRouteIdRef.current = null;
      }
    } else {
      focusRoute(route);  // dibuja, resalta y centra
    }
  };

  // Mostrar y enfocar una línea: dibuja su ruta (si estaba oculta), centra el
  // mapa en ella y la resalta. Es el corazón del modo on-demand.
  const focusRoute = (route: RouteType) => {
    const map = mapRef.current;
    if (!map) return;

    // Asegurar que la ruta esté dibujada antes de enfocarla
    let lineLayer = lineObjectsRef.current[route.id];
    if (!lineLayer) {
      const updated = { ...visibleRoutes, [route.id]: true };
      setVisibleRoutes(updated);
      plotRoutes(routes, updated);           // plotRoutes es síncrono
      lineLayer = lineObjectsRef.current[route.id];
    }

    if (lineLayer) {
      map.fitBounds(lineLayer.getBounds(), { padding: [50, 50] });
      lineLayer.setStyle({ weight: 8, opacity: 1.0 });
      setTimeout(() => {
        lineLayer?.setStyle({ weight: 4, opacity: 0.85 });
      }, 3000);
    }

    // Resaltar las paradas que pertenecen a esta ruta
    highlightRouteStops(route);
  };

  // Resaltar (con círculos del color de la línea) las paradas de una ruta
  const highlightRouteStops = (route: RouteType) => {
    const layer = routeStopsLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    highlightedRouteIdRef.current = route.id;

    const idSet = new Set(route.stopIds ?? []);
    stops
      .filter((s) => idSet.has(s.id))
      .forEach((s) => {
        L.circleMarker([s.latitude, s.longitude], {
          radius: 7,
          color: '#ffffff',
          weight: 2,
          fillColor: route.color,
          fillOpacity: 1,
        })
          .bindPopup(`<strong>${s.name}</strong><br><span style="font-size:11px;color:${route.color}">${route.name}</span>`)
          .addTo(layer);
      });
  };

  // Dibujar en el mapa todas las rutas que pasan por una parada seleccionada
  const showStopRoutes = (stop: StopType) => {
    const relevantes = routes.filter((r) => (r.stopIds ?? []).includes(stop.id));
    if (relevantes.length === 0) return;

    const vis: Record<string, boolean> = { ...visibleRoutesRef.current };
    relevantes.forEach((r) => { vis[r.id] = true; });
    setVisibleRoutes(vis);
    plotRoutes(routes, vis);

    // Ajustar la vista para abarcar la parada y todas sus rutas
    const map = mapRef.current;
    if (map) {
      const bounds = L.latLngBounds([[stop.latitude, stop.longitude]]);
      relevantes.forEach((r) => {
        const layer = lineObjectsRef.current[r.id];
        if (layer) bounds.extend(layer.getBounds());
      });
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [60, 60] });
    }
  };

  // Quitar del mapa las rutas que pasan por una parada (lo contrario a seleccionar)
  const hideStopRoutes = (stop: StopType) => {
    const vis: Record<string, boolean> = { ...visibleRoutesRef.current };
    routes
      .filter((r) => (r.stopIds ?? []).includes(stop.id))
      .forEach((r) => { vis[r.id] = false; });
    setVisibleRoutes(vis);
    plotRoutes(routes, vis);
    routeStopsLayerRef.current?.clearLayers();
    highlightedRouteIdRef.current = null;
  };

  // Mostrar TODAS las rutas en el mapa
  const showAllRoutes = () => {
    const all: Record<string, boolean> = {};
    routes.forEach((r) => { all[r.id] = true; });
    setVisibleRoutes(all);
    plotRoutes(routes, all);
  };

  // Ocultar todas las líneas dibujadas y sus paradas resaltadas
  const hideAllRoutes = () => {
    const cleared: Record<string, boolean> = {};
    routes.forEach((r) => { cleared[r.id] = false; });
    setVisibleRoutes(cleared);
    plotRoutes(routes, cleared);
    routeStopsLayerRef.current?.clearLayers();
    highlightedRouteIdRef.current = null;
  };

  // Deseleccionar la parada actual: quita sus rutas del mapa y limpia el resaltado
  const deselectStop = () => {
    if (selectedStop) {
      const updated = { ...visibleRoutes };
      routes
        .filter((r) => (r.stopIds ?? []).includes(selectedStop.id))
        .forEach((r) => { updated[r.id] = false; });
      setVisibleRoutes(updated);
      plotRoutes(routes, updated);
    }
    routeStopsLayerRef.current?.clearLayers();
    highlightedRouteIdRef.current = null;
    setSelectedStop(null);
  };

  // Enfocar una parada: la hace visible, centra el mapa y abre su popup
  const focusStop = (stop: StopType) => {
    const map = mapRef.current;
    if (!map) return;

    setSelectedStop(stop);

    // Asegurar que esta parada esté dibujada (aunque el resto siga oculto)
    const updated = { ...visibleStops, [stop.id]: true };
    setVisibleStops(updated);
    plotStops(stops, updated);   // plotStops es síncrono

    map.setView([stop.latitude, stop.longitude], 16);
    stopMarkersRef.current[stop.id]?.openPopup();
  };

  // Mostrar / ocultar una parada individual (checkbox de la lista)
  const toggleStopVisibility = (stopId: string) => {
    const updated = { ...visibleStops, [stopId]: !visibleStops[stopId] };
    setVisibleStops(updated);
    plotStops(stops, updated);
  };

  // Mostrar todas las paradas
  const showAllStops = () => {
    const all: Record<string, boolean> = {};
    stops.forEach((s) => { all[s.id] = true; });
    setVisibleStops(all);
    plotStops(stops, all);
  };

  // Ocultar todas las paradas Y también sus rutas/resaltados (limpia el mapa)
  const hideAllStops = () => {
    const clearedStops: Record<string, boolean> = {};
    stops.forEach((s) => { clearedStops[s.id] = false; });
    setVisibleStops(clearedStops);
    plotStops(stops, clearedStops);

    const clearedRoutes: Record<string, boolean> = {};
    routes.forEach((r) => { clearedRoutes[r.id] = false; });
    setVisibleRoutes(clearedRoutes);
    plotRoutes(routes, clearedRoutes);

    routeStopsLayerRef.current?.clearLayers();
    highlightedRouteIdRef.current = null;
    setSelectedStop(null);
  };

  // Búsqueda en tiempo real
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      fetchData();
      return;
    }

    try {
      const stopsResults = await graphqlService.searchStops(searchQuery);
      const routesResults = await graphqlService.searchRoutes(searchQuery);

      if (activeTab === 'stops') {
        setStops(stopsResults);
        // Mostrar los resultados de la búsqueda en el mapa
        const stopVis: Record<string, boolean> = {};
        stopsResults.forEach((s: StopType) => { stopVis[s.id] = true; });
        setVisibleStops(stopVis);
        plotStops(stopsResults, stopVis);
        if (stopsResults.length > 0) {
          mapRef.current?.setView([stopsResults[0].latitude, stopsResults[0].longitude], 14);
        }
      } else {
        // Para líneas, filtramos en el estado y actualizamos mapa
        setRoutes(routesResults);
        const visibility: Record<string, boolean> = {};
        routesResults.forEach((r: RouteType) => {
          visibility[r.id] = true;
        });
        setVisibleRoutes(visibility);
        plotRoutes(routesResults, visibility);
      }
    } catch (error) {
      console.error("Error realizando búsqueda:", error);
    }
  };

  // --- Marcadores de Origen y Destino -------------------------------------
  const placeMarker = (
    ref: React.RefObject<L.Marker | null>,
    lat: number, lng: number, color: string, label: string,
  ) => {
    const map = mapRef.current;
    if (!map) return;
    if (ref.current) {
      ref.current.setLatLng([lat, lng]);
    } else {
      const icon = L.divIcon({
        className: 'od-marker',
        html: `<div style="position: relative;">
            <div style="background-color: ${color}; width: 18px; height: 18px; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 10px ${color}88;"></div>
          </div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      ref.current = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
        .bindPopup(`<strong>${label}</strong>`)
        .addTo(map);
    }
  };

  // Marca el ORIGEN (punto de partida) en el mapa (mismo color que el destino)
  const setOrigin = (lat: number, lng: number) => {
    setOriginCoords([lat, lng]);
    placeMarker(originMarkerRef, lat, lng, '#ef4444', 'Punto de partida (origen)');
  };

  // Marca el DESTINO en el mapa
  const setDestination = (lat: number, lng: number) => {
    setDestCoords([lat, lng]);
    placeMarker(destMarkerRef, lat, lng, '#ef4444', 'Destino');
  };

  // Click en el mapa: solo marca origen o destino (según el modo). No hace nada más.
  const handleMapClick = (lat: number, lng: number) => {
    if (clickModeRef.current === 'destination') {
      setDestination(lat, lng);
      setClickMode('origin');
      clickModeRef.current = 'origin';
    } else {
      setOrigin(lat, lng);
    }
  };

  // --- Parada más cercana (peatonal) al ORIGEN marcado --------------------
  const findClosestStop = async () => {
    if (!originCoords) {
      alert('Primero marca tu punto de partida haciendo click en el mapa.');
      return;
    }
    const [lat, lng] = originCoords;
    const map = mapRef.current;

    try {
      const closest = await graphqlService.getClosestStop(lat, lng);
      if (!closest) {
        alert('No se encontraron paradas en la base de datos.');
        return;
      }
      setClosestStop(closest);
      setSelectedStop(closest);

      // Hacer visible la parada más cercana
      const updatedVis = { ...visibleStops, [closest.id]: true };
      setVisibleStops(updatedVis);
      plotStops(stops, updatedVis);

      // Trazar el camino PEATONAL (foot) hasta la parada; si falla, recta directa
      if (map) {
        let pathLatLngs: [number, number][] = [[lat, lng], [closest.latitude, closest.longitude]];
        try {
          const walk = await getStreetRoute([lat, lng], [closest.latitude, closest.longitude]);
          if (walk && walk.path.length > 1) pathLatLngs = walk.path;
        } catch (e) {
          console.warn('Ruteo peatonal no disponible, usando línea directa:', e);
        }
        if (closestPathRef.current) {
          closestPathRef.current.setLatLngs(pathLatLngs);
        } else {
          closestPathRef.current = L.polyline(pathLatLngs, {
            color: '#10b981', weight: 4, opacity: 0.85, lineCap: 'round', lineJoin: 'round',
          }).addTo(map);
        }
        map.fitBounds(L.latLngBounds(pathLatLngs), { padding: [80, 80] });
      }
    } catch (error) {
      console.error('Error consultando parada más cercana:', error);
    }
  };

  // --- Planificador: "Ir a dirección" (origen -> destino) -----------------
  const handleGeocode = async (e: React.FormEvent) => {
    e.preventDefault();
    setTripError(null);
    setGeocodeError(null);

    if (!originCoords) {
      setTripError('Primero marca tu punto de partida en el mapa.');
      return;
    }

    // Determinar el destino: dirección escrita (geocodificar) o destino marcado
    let dest = destCoords;
    if (addressQuery.trim()) {
      setGeocoding(true);
      try {
        const result = await geocodeAddress(addressQuery);
        if (!result) {
          setGeocodeError('No se encontró esa dirección en Santa Cruz.');
          setGeocoding(false);
          return;
        }
        dest = [result.latitude, result.longitude];
        setDestination(result.latitude, result.longitude);
      } catch (err) {
        console.error('Error en geocodificación:', err);
        setGeocodeError('Error consultando el geocodificador. Reintenta.');
        setGeocoding(false);
        return;
      }
      setGeocoding(false);
    }

    if (!dest) {
      setTripError('Escribe una dirección de destino o márcalo en el mapa.');
      return;
    }

    // Buscar líneas que conecten origen y destino
    setTripLoading(true);
    setTripRoutes(null);
    try {
      const [oLat, oLng] = originCoords;
      const [dLat, dLng] = dest;
      const results: RouteType[] = await graphqlService.getRoutesBetween(oLat, oLng, dLat, dLng);
      setTripRoutes(results);
      const map = mapRef.current;
      if (map) {
        map.fitBounds(L.latLngBounds([[oLat, oLng], [dLat, dLng]]), { padding: [80, 80] });
      }
    } catch (err) {
      console.error('Error buscando líneas:', err);
      setTripError('Error buscando líneas. Reintenta.');
    } finally {
      setTripLoading(false);
    }
  };

  // Activar el modo "marcar destino en el mapa" (el próximo click fija el destino)
  const startMarkDestination = () => {
    setClickMode('destination');
    clickModeRef.current = 'destination';
  };

  // Limpiar todo el planificador (origen, destino, ruta, resultados)
  const clearTrip = () => {
    const map = mapRef.current;
    if (map) {
      [originMarkerRef, destMarkerRef].forEach((ref) => {
        if (ref.current) { map.removeLayer(ref.current); ref.current = null; }
      });
      if (closestPathRef.current) { map.removeLayer(closestPathRef.current); closestPathRef.current = null; }
    }
    setOriginCoords(null);
    setDestCoords(null);
    setClosestStop(null);
    setTripRoutes(null);
    setTripError(null);
    setClickMode('origin');
    clickModeRef.current = 'origin';
  };

  return (
    <div className="app-container">
      {/* 1. Panel Lateral */}
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="brand">
            <div className="brand-icon">
              <Bus size={22} />
            </div>
            <div>
              <h1 className="brand-title">Visor SIG</h1>
              <span className="brand-subtitle">Transporte Santa Cruz</span>
            </div>
          </div>
          <button 
            className="floating-btn" 
            style={{ boxShadow: 'none', width: 36, height: 36, borderRadius: 10 }}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>

        <div className="sidebar-content">
          {/* Buscador */}
          <form onSubmit={handleSearch} className="search-container">
            <div className="search-input-wrapper">
              <input
                type="text"
                className="search-input"
                placeholder={activeTab === 'stops' ? "Buscar parada por nombre..." : "Buscar línea (ej: 72)..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <Search className="search-icon" size={18} />
            </div>
            
            <div className="tabs">
              <button
                type="button"
                className={`tab-btn ${activeTab === 'stops' ? 'active' : ''}`}
                onClick={() => { setActiveTab('stops'); setSearchQuery(''); fetchData(); }}
              >
                Paradas ({stops.length})
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === 'routes' ? 'active' : ''}`}
                onClick={() => { setActiveTab('routes'); setSearchQuery(''); fetchData(); }}
              >
                Líneas ({routes.length})
              </button>
            </div>
          </form>

          {/* Planificador: Origen -> Destino */}
          <div className="search-container" style={{ gap: 8 }}>
            {/* Estado del origen */}
            <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }}></span>
              <strong>Origen:</strong>
              <span style={{ color: 'var(--text-secondary)' }}>
                {originCoords ? `${originCoords[0].toFixed(4)}, ${originCoords[1].toFixed(4)}` : 'haz click en el mapa'}
              </span>
            </div>

            <button className="action-btn" onClick={findClosestStop}>
              <Navigation size={16} />
              Parada más cercana
            </button>

            {/* Destino: dirección escrita o marcado en el mapa */}
            <form onSubmit={handleGeocode} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }}></span>
                <strong>Destino:</strong>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {destCoords ? `${destCoords[0].toFixed(4)}, ${destCoords[1].toFixed(4)}` : 'escribe o marca en el mapa'}
                </span>
              </div>
              <div className="search-input-wrapper">
                <input
                  type="text"
                  className="search-input"
                  placeholder="Dirección destino (ej: Av. Busch 2do anillo)..."
                  value={addressQuery}
                  onChange={(e) => { setAddressQuery(e.target.value); setGeocodeError(null); }}
                />
                <MapPin className="search-icon" size={18} />
              </div>
              <button
                type="button"
                className={`action-btn secondary ${clickMode === 'destination' ? 'active' : ''}`}
                onClick={startMarkDestination}
                title="Luego haz click en el mapa para fijar el destino"
              >
                <MapPin size={15} />
                {clickMode === 'destination' ? 'Haz click en el mapa…' : 'Marcar destino en el mapa'}
              </button>
              <button className="action-btn" type="submit" disabled={geocoding || tripLoading}>
                <Compass size={16} />
                {tripLoading ? 'Buscando líneas…' : geocoding ? 'Buscando dirección…' : 'Ir a dirección (buscar líneas)'}
              </button>
              {(geocodeError || tripError) && (
                <span style={{ fontSize: 11, color: 'var(--danger, #ef4444)' }}>
                  {geocodeError || tripError}
                </span>
              )}
            </form>

            {(originCoords || destCoords || tripRoutes) && (
              <button className="action-btn secondary" onClick={clearTrip}>
                <Trash2 size={15} /> Limpiar
              </button>
            )}

            {/* Resultados del planificador */}
            {tripRoutes && (
              <div style={{ marginTop: 4 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  {tripRoutes.length > 0
                    ? `${tripRoutes.length} línea(s) te llevan al destino:`
                    : 'No se encontraron líneas directas para ese trayecto.'}
                </h3>
                {tripRoutes.map((route) => (
                  <div key={route.id} className="item-card" onClick={() => toggleTripRoute(route)}>
                    <div className="item-info" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: route.color }}></div>
                      <span className="item-name">{route.name}</span>
                    </div>
                    <span style={{ fontSize: 11, color: visibleRoutes[route.id] ? 'var(--danger, #ef4444)' : 'var(--primary)' }}>
                      {visibleRoutes[route.id] ? 'Ocultar ruta' : 'Ver ruta'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Listado Principal */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <h2 className="section-title" style={{ marginBottom: 0 }}>
                {activeTab === 'stops' ? <MapPin size={18} /> : <Layers size={18} />}
                {activeTab === 'stops' ? 'Paradas Registradas' : 'Líneas de Micros'}
              </h2>

              {/* Controles de la pestaña Paradas: mostrar todas / ocultar todas */}
              {activeTab === 'stops' && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="action-btn"
                    style={{ padding: '4px 10px', fontSize: 11 }}
                    onClick={showAllStops}
                    title="Mostrar todas las paradas en el mapa"
                  >
                    <MapPin size={13} /> Mostrar todas
                  </button>
                  {Object.values(visibleStops).some(Boolean) && (
                    <button
                      className="action-btn secondary"
                      style={{ padding: '4px 10px', fontSize: 11 }}
                      onClick={hideAllStops}
                      title="Ocultar todas las paradas del mapa"
                    >
                      <Trash2 size={13} /> Ocultar
                    </button>
                  )}
                </div>
              )}

              {/* Controles de la pestaña Líneas: mostrar todas / ocultar todas */}
              {activeTab === 'routes' && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="action-btn"
                    style={{ padding: '4px 10px', fontSize: 11 }}
                    onClick={showAllRoutes}
                    title="Dibujar todas las líneas en el mapa"
                  >
                    <Layers size={13} /> Mostrar todas
                  </button>
                  {Object.values(visibleRoutes).some(Boolean) && (
                    <button
                      className="action-btn secondary"
                      style={{ padding: '4px 10px', fontSize: 11 }}
                      onClick={hideAllRoutes}
                      title="Ocultar todas las líneas del mapa"
                    >
                      <Trash2 size={13} /> Ocultar
                    </button>
                  )}
                </div>
              )}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted, #94a3b8)', margin: '4px 0 8px' }}>
              {activeTab === 'routes'
                ? 'Toca una línea para ver su recorrido en el mapa.'
                : 'Toca una parada para verla en el mapa.'}
            </p>

            <div className="scroll-list">
              {activeTab === 'stops' ? (
                stops.map((stop) => (
                  <div
                    key={stop.id}
                    className="item-card"
                    onClick={() => focusStop(stop)}
                  >
                    <div className="item-info">
                      <span className="item-name">{stop.name}</span>
                      <span className="item-desc">{stop.routes.length} líneas pasan por aquí</span>
                    </div>
                    <label
                      className="switch"
                      onClick={(e) => e.stopPropagation()}
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    >
                      <input
                        type="checkbox"
                        checked={visibleStops[stop.id] === true}
                        onChange={() => toggleStopVisibility(stop.id)}
                        style={{ marginRight: 6 }}
                      />
                      <span style={{ fontSize: 11, fontWeight: 500 }}>
                        {visibleStops[stop.id] === true ? 'Visible' : 'Oculto'}
                      </span>
                    </label>
                  </div>
                ))
              ) : (
                routes.map((route) => {
                  // Una misma línea comercial puede tener varios recorridos en OSM
                  // (ej. 3 "Línea 1"). Los diferenciamos con un número de recorrido.
                  const mismoNombre = routes.filter((r) => r.name === route.name);
                  const label = mismoNombre.length > 1
                    ? `${route.name} · recorrido ${mismoNombre.findIndex((r) => r.id === route.id) + 1}`
                    : route.name;
                  return (
                  <div
                    key={route.id}
                    className="item-card"
                    onClick={() => focusRoute(route)}
                  >
                    <div className="item-info" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: route.color }}></div>
                      <span className="item-name">{label}</span>
                    </div>
                    <label 
                      className="switch" 
                      onClick={(e) => e.stopPropagation()} 
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    >
                      <input
                        type="checkbox"
                        checked={visibleRoutes[route.id] === true}
                        onChange={() => toggleRouteVisibility(route)}
                        style={{ marginRight: 6 }}
                      />
                      <span style={{ fontSize: 11, fontWeight: 500 }}>
                        {visibleRoutes[route.id] === true ? 'Visible' : 'Oculto'}
                      </span>
                    </label>
                  </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Detalle de Parada Seleccionada */}
          {selectedStop && (
            <div className="detail-panel">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <h3 className="detail-title" style={{ marginBottom: 0 }}>{selectedStop.name}</h3>
                <button
                  className="action-btn secondary"
                  style={{ padding: '4px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
                  onClick={deselectStop}
                  title="Quitar esta parada y sus rutas del mapa"
                >
                  <Trash2 size={13} /> Deseleccionar
                </button>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                Coordenadas: {selectedStop.latitude.toFixed(5)}, {selectedStop.longitude.toFixed(5)}
              </p>
              {closestStop && closestStop.id === selectedStop.id && closestStop.distance != null && (
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--success, #10b981)', marginTop: 4 }}>
                  <Navigation size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  A {closestStop.distance >= 1000
                    ? `${(closestStop.distance / 1000).toFixed(2)} km`
                    : `${Math.round(closestStop.distance)} m`} de tu ubicación
                </p>
              )}
              
              <div style={{ marginTop: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>
                  Líneas de micros que pasan:
                </span>
                <div className="detail-routes">
                  {selectedStop.routes.length > 0 ? (
                    selectedStop.routes.map(r => (
                      <span 
                        key={r.id}
                        className="route-tag" 
                        style={{ backgroundColor: r.color, cursor: 'pointer' }}
                        onClick={() => {
                          const matchingRoute = routes.find(routeItem => routeItem.id === r.id);
                          if (matchingRoute) focusRoute(matchingRoute);
                        }}
                      >
                        {r.name}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ninguna</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Panel de Estadísticas (SIG) */}
          <div style={{ marginTop: 'auto' }}>
            <h2 className="section-title">
              <Compass size={18} />
              Estadísticas GIS (Base de Datos)
            </h2>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-number">{stops.length}</div>
                <div className="stat-label">Paradas</div>
              </div>
              <div className="stat-card">
                <div className="stat-number">{routes.length}</div>
                <div className="stat-label">Líneas</div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* 2. Contenedor de Leaflet */}
      <main className="map-container">
        <div id="map"></div>

        {/* Controles flotantes sobre el mapa: instrucciones ocultables */}
        <div className="map-floating-controls">
          {showInstructions ? (
            <div style={{
              background: 'var(--bg-primary)',
              backdropFilter: 'var(--blur)',
              padding: '10px 12px',
              borderRadius: '12px',
              border: '1px solid var(--border-color)',
              boxShadow: 'var(--shadow)',
              fontSize: '11px',
              maxWidth: '230px',
              position: 'relative'
            }}>
              <button
                onClick={() => setShowInstructions(false)}
                title="Ocultar instrucciones"
                style={{
                  position: 'absolute', top: 6, right: 6, background: 'transparent',
                  border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 2,
                  display: 'flex'
                }}
              >
                <X size={14} />
              </button>
              <strong style={{ display: 'block', marginBottom: '6px', paddingRight: 16 }}>
                <Info size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Cómo usar
              </strong>
              <ol style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <li>Haz click en el mapa para marcar tu <strong>punto de partida</strong>.</li>
                <li><strong>Parada más cercana</strong>: la parada a pie más próxima (sin sentidos de tránsito).</li>
                <li><strong>Ir a dirección</strong>: escribe o marca un destino y verás las líneas que te llevan.</li>
              </ol>
            </div>
          ) : (
            <button
              onClick={() => setShowInstructions(true)}
              title="Mostrar instrucciones"
              style={{
                background: 'var(--bg-primary)', backdropFilter: 'var(--blur)',
                border: '1px solid var(--border-color)', boxShadow: 'var(--shadow)',
                borderRadius: '50%', width: 36, height: 36, cursor: 'pointer',
                color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}
            >
              <Info size={18} />
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
