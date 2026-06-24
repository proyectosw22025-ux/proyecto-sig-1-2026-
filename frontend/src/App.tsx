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
  Trash2
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
  
  // Ubicación del usuario simulada o real
  const [userCoords, setUserCoords] = useState<[number, number] | null>(null);
  const [closestStop, setClosestStop] = useState<StopType | null>(null);

  // Geocodificador (dirección -> coordenada)
  const [addressQuery, setAddressQuery] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);

  const mapRef = useRef<L.Map | null>(null);
  const stopsClusterGroupRef = useRef<L.MarkerClusterGroup | null>(null);
  const routesLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const closestPathRef = useRef<L.Polyline | null>(null);

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
    const clusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 40
    });
    map.addLayer(clusterGroup);
    stopsClusterGroupRef.current = clusterGroup;

    const routesGroup = L.layerGroup();
    map.addLayer(routesGroup);
    routesLayerGroupRef.current = routesGroup;

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

  // Carga inicial de datos desde GraphQL
  const fetchData = async () => {
    try {
      const stopsData = await graphqlService.getStops();
      const routesData = await graphqlService.getRoutes();

      setStops(stopsData);
      setRoutes(routesData);

      // Por defecto, todas las líneas son visibles en el mapa
      const visibility: Record<string, boolean> = {};
      routesData.forEach((r: RouteType) => {
        visibility[r.id] = true;
      });
      setVisibleRoutes(visibility);

      // Pintar en el mapa
      plotStops(stopsData);
      plotRoutes(routesData, visibility);
    } catch (error) {
      console.error("Error cargando datos del backend:", error);
    }
  };

  // Dibujar paradas (Stops) con Clusters
  const plotStops = (stopsList: StopType[]) => {
    const cluster = stopsClusterGroupRef.current;
    if (!cluster) return;

    cluster.clearLayers();

    stopsList.forEach((stop) => {
      // Icono personalizado SVG para paradas de micro
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
            transition: all 0.2s ease;
          "></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      const marker = L.marker([stop.latitude, stop.longitude], { icon: stopIcon });

      // Popup HTML al hacer click en la parada
      const popupContent = document.createElement('div');
      popupContent.style.fontFamily = 'var(--font-body)';
      popupContent.style.padding = '5px';
      
      const routesTags = stop.routes.map(r => 
        `<span class="route-tag" style="background-color: ${r.color}; margin-right: 4px; padding: 2px 6px; border-radius: 4px; color: white; font-size: 10px; font-weight: bold; display: inline-block;">
          ${r.name.split(' ')[1] || r.name}
         </span>`
      ).join('');

      popupContent.innerHTML = `
        <h4 style="font-family: var(--font-title); font-weight: 700; font-size: 14px; margin-bottom: 6px; color: var(--text-primary);">${stop.name}</h4>
        <p style="font-size: 11px; color: var(--text-secondary); margin-bottom: 10px;">Parada de transporte público</p>
        <div style="margin-bottom: 12px;">${routesTags || '<span style="font-size: 11px; color: var(--text-muted);">Sin líneas asignadas</span>'}</div>
        <button id="popup-btn-${stop.id}" style="
          background: var(--primary);
          color: white;
          border: none;
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          width: 100%;
        ">Seleccionar parada</button>
      `;

      marker.bindPopup(popupContent);

      // Evento al abrir popup para enlazar botón y evento de selección
      marker.on('popupopen', () => {
        const btn = document.getElementById(`popup-btn-${stop.id}`);
        if (btn) {
          btn.onclick = () => {
            setSelectedStop(stop);
            mapRef.current?.closePopup();
          };
        }
      });

      marker.on('click', () => {
        setSelectedStop(stop);
      });

      cluster.addLayer(marker);
    });
  };

  // Dibujar líneas/rutas de micro (Polylines)
  const plotRoutes = (routesList: RouteType[], visibility: Record<string, boolean>) => {
    const group = routesLayerGroupRef.current;
    if (!group) return;

    group.clearLayers();
    lineObjectsRef.current = {};

    routesList.forEach((route) => {
      if (!visibility[route.id] || !route.geom_geojson) return;

      try {
        const geom = JSON.parse(route.geom_geojson);
        
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
  const toggleRouteVisibility = (routeId: string) => {
    const updated = {
      ...visibleRoutes,
      [routeId]: !visibleRoutes[routeId]
    };
    setVisibleRoutes(updated);
    plotRoutes(routes, updated);
  };

  // Resaltar y enfocar una línea específica
  const focusRoute = (route: RouteType) => {
    const map = mapRef.current;
    const lineLayer = lineObjectsRef.current[route.id];
    
    if (map && lineLayer) {
      // Ajustar la vista del mapa a los límites de la línea
      const bounds = lineLayer.getBounds();
      map.fitBounds(bounds, { padding: [50, 50] });
      
      // Resaltar temporalmente la línea
      lineLayer.setStyle({ weight: 8, opacity: 1.0 });
      setTimeout(() => {
        lineLayer.setStyle({ weight: 4, opacity: 0.85 });
      }, 3000);
    }
  };

  // Enfocar una parada en el mapa
  const focusStop = (stop: StopType) => {
    const map = mapRef.current;
    if (map) {
      map.setView([stop.latitude, stop.longitude], 16);
      setSelectedStop(stop);
      
      // Buscar la parada dentro del cluster y abrir su popup
      stopsClusterGroupRef.current?.eachLayer((layer: any) => {
        const latlng = layer.getLatLng();
        if (latlng.lat === stop.latitude && latlng.lng === stop.longitude) {
          layer.openPopup();
        }
      });
    }
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
        plotStops(stopsResults);
        if (stopsResults.length > 0) {
          // Centrar en el primer resultado
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

  // Geolocalización y Parada más Cercana
  const findClosestStop = () => {
    if (!navigator.geolocation) {
      alert("La geolocalización no está soportada por tu navegador.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        await processClosestStop(latitude, longitude);
      },
      () => {
        console.warn("Error de geolocalización real, usando ubicación simulada en el centro de Santa Cruz...");
        // Ubicación simulada cerca de la Av. Busch y 2do Anillo (cerca de paradas)
        processClosestStop(-17.7780, -63.1900);
      }
    );
  };

  // Procesamiento común al hacer click en el mapa o usar GPS
  const processClosestStop = async (lat: number, lng: number) => {
    setUserCoords([lat, lng]);
    const map = mapRef.current;

    // Pintar marcador del usuario
    if (map) {
      if (userMarkerRef.current) {
        userMarkerRef.current.setLatLng([lat, lng]);
      } else {
        const userIcon = L.divIcon({
          className: 'user-marker',
          html: `
            <div style="position: relative;">
              <div style="background-color: #10b981; width: 18px; height: 18px; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 10px rgba(16,185,129,0.5);"></div>
              <div style="position: absolute; top: -3px; left: -3px; background-color: rgba(16,185,129,0.3); width: 24px; height: 24px; border-radius: 50%; animation: ping 1.5s infinite;"></div>
            </div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });
        userMarkerRef.current = L.marker([lat, lng], { icon: userIcon })
          .bindPopup(`<strong>Tu ubicación</strong><br>Simulada o GPS`)
          .addTo(map);
      }
    }

    try {
      // Llamar al endpoint espacial del backend (PostGIS Distance)
      const closest = await graphqlService.getClosestStop(lat, lng);
      
      if (closest) {
        setClosestStop(closest);
        setSelectedStop(closest);
        
        // Trazar el camino hasta la parada. Intentamos seguir las CALLES (OSRM);
        // si el servicio no responde, caemos a una recta directa.
        if (map) {
          let pathLatLngs: [number, number][] = [[lat, lng], [closest.latitude, closest.longitude]];
          try {
            const streetRoute = await getStreetRoute([lat, lng], [closest.latitude, closest.longitude]);
            if (streetRoute && streetRoute.path.length > 1) {
              pathLatLngs = streetRoute.path;
            }
          } catch (e) {
            console.warn('Ruteo por calles no disponible, usando línea directa:', e);
          }

          if (closestPathRef.current) {
            closestPathRef.current.setLatLngs(pathLatLngs);
          } else {
            closestPathRef.current = L.polyline(pathLatLngs, {
              color: '#10b981',
              weight: 4,
              opacity: 0.85,
              lineCap: 'round',
              lineJoin: 'round'
            }).addTo(map);
          }

          // Ajustar vista para contener todo el recorrido
          map.fitBounds(L.latLngBounds(pathLatLngs), { padding: [80, 80] });
        }
      } else {
        alert("No se encontraron paradas en la base de datos.");
      }
    } catch (error) {
      console.error("Error consultando parada más cercana:", error);
    }
  };

  // Manejar el click en el mapa para simular ubicación de búsqueda
  const handleMapClick = (lat: number, lng: number) => {
    processClosestStop(lat, lng);
  };

  // Geocodificación: dirección de texto -> coordenada (Nominatim/OSM)
  const handleGeocode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addressQuery.trim()) return;

    setGeocoding(true);
    setGeocodeError(null);
    try {
      const result = await geocodeAddress(addressQuery);
      if (!result) {
        setGeocodeError('No se encontró esa dirección en Santa Cruz.');
        return;
      }
      // Centramos el mapa en la dirección y calculamos la parada más cercana a ella
      await processClosestStop(result.latitude, result.longitude);
    } catch (error) {
      console.error('Error en geocodificación:', error);
      setGeocodeError('Error consultando el geocodificador. Reintenta.');
    } finally {
      setGeocoding(false);
    }
  };

  // Limpiar la ruta y marcador de geolocalización
  const clearClosestRoute = () => {
    const map = mapRef.current;
    if (map) {
      if (userMarkerRef.current) {
        map.removeLayer(userMarkerRef.current);
        userMarkerRef.current = null;
      }
      if (closestPathRef.current) {
        map.removeLayer(closestPathRef.current);
        closestPathRef.current = null;
      }
    }
    setUserCoords(null);
    setClosestStop(null);
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

          {/* Botones de Geolocalización */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button 
              className="action-btn" 
              style={{ flex: 1 }} 
              onClick={findClosestStop}
            >
              <Navigation size={16} />
              Parada más cercana
            </button>
            {userCoords && (
              <button
                className="action-btn secondary"
                style={{ padding: 12 }}
                onClick={clearClosestRoute}
                title="Limpiar búsqueda"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {/* Geocodificador: dirección -> coordenada (OpenStreetMap / Nominatim) */}
          <form onSubmit={handleGeocode} className="search-container" style={{ marginTop: 4 }}>
            <div className="search-input-wrapper">
              <input
                type="text"
                className="search-input"
                placeholder="Ir a una dirección (ej: Av. Busch 2do anillo)..."
                value={addressQuery}
                onChange={(e) => { setAddressQuery(e.target.value); setGeocodeError(null); }}
              />
              <MapPin className="search-icon" size={18} />
            </div>
            <button className="action-btn" type="submit" disabled={geocoding} style={{ marginTop: 8 }}>
              <Compass size={16} />
              {geocoding ? 'Buscando dirección...' : 'Ir a dirección'}
            </button>
            {geocodeError && (
              <span style={{ fontSize: 11, color: 'var(--danger, #ef4444)', marginTop: 6, display: 'block' }}>
                {geocodeError}
              </span>
            )}
          </form>

          {/* Listado Principal */}
          <div>
            <h2 className="section-title">
              {activeTab === 'stops' ? <MapPin size={18} /> : <Layers size={18} />}
              {activeTab === 'stops' ? 'Paradas Registradas' : 'Líneas de Micros'}
            </h2>

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
                    <MapPin size={16} style={{ color: 'var(--primary)' }} />
                  </div>
                ))
              ) : (
                routes.map((route) => (
                  <div 
                    key={route.id} 
                    className="item-card"
                    onClick={() => focusRoute(route)}
                  >
                    <div className="item-info" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: route.color }}></div>
                      <span className="item-name">{route.name}</span>
                    </div>
                    <label 
                      className="switch" 
                      onClick={(e) => e.stopPropagation()} 
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    >
                      <input 
                        type="checkbox" 
                        checked={visibleRoutes[route.id] !== false} 
                        onChange={() => toggleRouteVisibility(route.id)}
                        style={{ marginRight: 6 }}
                      />
                      <span style={{ fontSize: 11, fontWeight: 500 }}>
                        {visibleRoutes[route.id] !== false ? 'Visible' : 'Oculto'}
                      </span>
                    </label>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Detalle de Parada Seleccionada */}
          {selectedStop && (
            <div className="detail-panel">
              <h3 className="detail-title">{selectedStop.name}</h3>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
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

        {/* Controles flotantes sobre el mapa */}
        <div className="map-floating-controls">
          <div style={{ 
            background: 'var(--bg-primary)', 
            backdropFilter: 'var(--blur)',
            padding: '10px', 
            borderRadius: '12px',
            border: '1px solid var(--border-color)',
            boxShadow: 'var(--shadow)',
            fontSize: '11px',
            maxWidth: '180px'
          }}>
            <strong style={{ display: 'block', marginBottom: '6px' }}><Info size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Instrucciones</strong>
            Click en cualquier parte del mapa para simular tu ubicación y calcular la parada de micro más cercana usando consultas espaciales en <strong>PostGIS</strong>.
          </div>
        </div>
      </main>
    </div>
  );
}
