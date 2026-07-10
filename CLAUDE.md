# CLAUDE.md

Este archivo brinda contexto a Claude Code (claude.ai/code) para trabajar en este repositorio.

## Resumen

Aplicación web SIG ("proyecto SIG") que mapea las líneas y paradas de transporte público de **Santa Cruz de la Sierra, Bolivia**. Un backend GeoDjango + PostGIS expone una API GraphQL; un frontend React + Leaflet dibuja el mapa interactivo. Los comentarios del código y los textos visibles al usuario están en español.

## Arquitectura

Dos aplicaciones independientes que se comunican por GraphQL:

- **`backend/`** — proyecto Django 5/6 `transit_project`, con una sola app `transit_app`.
  - **Modelo espacial normalizado** (inspirado en GTFS) en [transit_app/models.py](backend/transit_app/models.py): `LineaMicro` (línea comercial: codigo/nombre/color) → `Ruta` (un recorrido por sentido: `sentido` IDA/VUELTA/CIRCULAR + `LineStringField`, FK a línea) → `RutaParada` (tabla puente ordenada con `orden`) → `Parada` (`PointField`). Toda la geometría usa SRID 4326, orden `(longitud, latitud)`. El campo `orden` es lo que da navegabilidad al recorrido (secuencia de paradas, próxima parada).
  - GraphQL usa **Strawberry** (no Graphene), definido en [transit_app/schema.py](backend/transit_app/schema.py). Los resolvers mapean manualmente los objetos del ORM a clases `@strawberry.type` (helpers `_route_type`/`_stop_type`). El contrato de la API está intencionalmente desacoplado del modelo de BD: `routes` devuelve variantes de `Ruta` (con `stopIds`, los IDs de las paradas de esa ruta, para resaltarlas), `stops` devuelve `Parada` cuyo campo `routes` resuelve las **líneas** distintas que pasan por ella. Queries: `stops`, `routes`, `lineas` (jerarquía completa Línea→Ruta→Parada para navegación), `searchStops`, `searchRoutes`, `closestStop`, `planTrip`. `closestStop` ordena por `Distance` de PostGIS y reporta metros reales vía `haversine_meters`. `planTrip(originLat, originLng, destLat, destLng, radiusM=500)` es el planificador de viajes: devuelve una lista de `TripOption` ordenadas por tiempo estimado (más rápido primero). Cada opción es **directa** (1 tramo/`TripLeg`, una línea) o **con transbordo** (`transfers=1`, 2 tramos + caminata intermedia); trae tiempos ESTIMADOS a pie y en micro con velocidades promedio (`WALK_SPEED_MS` ~4.8 km/h, `BUS_SPEED_MS` ~15 km/h con tráfico — constantes documentadas en [schema.py](backend/transit_app/schema.py)). Combina directas (rutas cerca de ambos puntos vía `dwithin`, radio ampliable) con transbordos (una línea cerca del origen + otra cerca del destino que se cruzan a ≤350 m a pie), y si no hay nada cae a un _fallback_ aproximado (`exact=False`) para nunca dejar sin opciones. Distancias/fracciones a lo largo del trazado se calculan en Python con GEOS (`geom.project`/`geom.length`), ignorando el sentido de circulación (pensado para peatones).
  - Strawberry convierte automáticamente los nombres de campo a camelCase: el `geom_geojson` de Python se consulta como `geomGeojson` desde el cliente.
  - Único endpoint montado en `/graphql/` en [transit_project/urls.py](backend/transit_project/urls.py), envuelto en `csrf_exempt` — **obligatorio**, o los POST de React reciben 403.
- **`frontend/`** — Vite + React 19 + TypeScript, la UI del mapa vive en el archivo único [src/App.tsx](frontend/src/App.tsx) (~1300 líneas, Leaflet + markercluster para agrupar las paradas). Todo el acceso a GraphQL pasa por el wrapper de fetch hecho a mano en [src/services/graphql.ts](frontend/src/services/graphql.ts); los tipos compartidos están en [src/types.ts](frontend/src/types.ts). Dos servicios más llaman directamente desde el navegador a **servicios externos de OSM sin API key**: [src/services/geocoding.ts](frontend/src/services/geocoding.ts) (Nominatim — texto de dirección → lat/lng, acotado al viewbox de Santa Cruz) y [src/services/routing.ts](frontend/src/services/routing.ts) (OSRM `routed-foot` — ruta peatonal entre dos puntos, cae a una línea recta si el servicio no responde).
  - El mapa dibuja las rutas bajo demanda: por defecto ninguna línea ni parada está visible. **Filtros de visualización** (apagados por defecto): mostrar las paradas de las rutas visibles, mostrar flechas de dirección (ida/vuelta, exactamente 3 por ruta por fracción de distancia), y agrupar paradas en clusters (activado por defecto). El **planificador** consume `planTrip` y lista opciones de viaje con su tiempo total y desglose a pie/en micro; al tocar una opción dibuja sus 1-2 líneas en el mapa. **Favoritos** de paradas y líneas se guardan en `localStorage` (helpers `loadFavorites`/`saveFavorites`, sin login) y se pueden filtrar con el botón ⭐ de cada pestaña. La carga inicial muestra un spinner y, si el backend falla, un banner de error con botón de reintento.

### Detalles cruzados a tener en cuenta

- **El backend debe correr en el puerto 8080.** El frontend tiene hardcodeado `http://localhost:8080/graphql/` en [src/services/graphql.ts](frontend/src/services/graphql.ts), pero Django por defecto usa el 8000. Levanta el servidor con `runserver 8080` (o cambia la constante). No hay proxy configurado en [vite.config.ts](frontend/vite.config.ts).
- CORS está totalmente abierto en desarrollo (`CORS_ALLOW_ALL_ORIGINS = True`) en [settings.py](backend/transit_project/settings.py); CSRF confía en los puertos 5173/5174.
- Las credenciales de BD, el `SECRET_KEY` y `DEBUG=True` están escritos directamente en [settings.py](backend/transit_project/settings.py) — es una configuración local/académica, no de producción.

## Instalación y comandos

### Opción A — Docker (recomendada; un solo comando levanta todo)

`docker-compose.yml` (raíz del repo) levanta los **3 servicios** — PostGIS, backend Django y frontend (build de producción servido por Nginx) — sin necesitar Postgres/GDAL/Node nativos:

```bash
docker compose up --build                                     # levanta db + backend + frontend, corre migrate automáticamente
docker compose exec backend python manage.py seed_microcruz   # datos reales (recomendado); también seed_db o seed_osm
```

Backend en `http://localhost:8080/graphql/` y frontend en `http://localhost:5173/`, igual que en nativo. [backend/transit_project/settings.py](backend/transit_project/settings.py) lee `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_PORT` desde el entorno (compose fija `DB_HOST=db`), y usa los valores hardcodeados como respaldo si no están definidos — la instalación nativa de abajo no se ve afectada. [frontend/Dockerfile](frontend/Dockerfile) es un build multi-stage: compila con `node:22-alpine` (`npm ci && npm run build`) y sirve el resultado estático con `nginx:alpine`. El frontend llama al backend por `http://localhost:8080` (hardcodeado, ver gotcha abajo), así que funciona igual estando ambos en contenedores separados: esa URL la resuelve el navegador en el host, no la red interna de Docker.

### Opción B — Backend nativo (sin Docker)

Requiere **PostgreSQL con la extensión PostGIS** (BD `transporte_db`, usuario `postgres`) y las librerías nativas **GDAL/GEOS**. En Windows, [settings.py](backend/transit_project/settings.py) las ubica automáticamente bajo `C:\Program Files\PostgreSQL\17\bin` (`libgdal-35.dll`, `libgeos_c.dll`) — ajusta esa ruta si PostgreSQL está instalado en otro lugar.

Ejecutar desde `backend/` con el venv activo (`venv\Scripts\activate` en Windows). Nota: `backend/venv/` está en `.gitignore` — cada máquina crea el suyo con `python -m venv venv`:

```bash
pip install -r requirements.txt        # Django, strawberry-graphql[django], psycopg2-binary, requests, django-cors-headers
python manage.py migrate               # aplica el esquema (PostGIS)
python manage.py seed_microcruz        # BORRA y recarga con datos REALES (recomendado): 147 líneas de Microcruz + paradas reales de OSM
python manage.py seed_db               # BORRA y recarga con datos curados de demo (offline)
python manage.py seed_osm              # BORRA y recarga con datos 100% OSM vía Overpass API (rutas y paradas de la misma fuente)
python manage.py runserver 8080        # debe ser 8080 — ver detalle arriba
python manage.py test                  # 16 tests: haversine, modelo espacial, esquema GraphQL, regresión CSRF
```

Los tres seeders **borran todas las Paradas y Rutas existentes antes de cargar**:

- `seed_microcruz` ([commands/seed_microcruz.py](backend/transit_app/management/commands/seed_microcruz.py)) — **el más completo**: combina las ~147 líneas reales (con trazado ida/vuelta) de la API pública de Microcruz (`https://microcruz.tel.bo`) con las paradas físicas reales de OSM (nodos `highway=bus_stop`/`public_transport=platform`; deliberadamente NO usa los "puntos" de grafo de calles de Microcruz, que son nodos de su buscador de rutas, no paradas físicas). Vincula cada parada a la ruta más cercana con `LineLocatePoint` + `dwithin`, misma lógica que `seed_osm`.
- `seed_db` ([commands/seed_db.py](backend/transit_app/management/commands/seed_db.py)) — 5 líneas y paradas hardcodeadas. Offline y determinista; útil como demo/respaldo confiable.
- `seed_osm` ([commands/seed_osm.py](backend/transit_app/management/commands/seed_osm.py)) — paradas/líneas reales de Santa Cruz desde la **Overpass API** (`requests`). Arma el `LineString` de cada ruta cosiendo los tramos (ways) de la relación con un algoritmo greedy, y vincula las paradas por membresía en la relación. Si Overpass falla o no devuelve nada, aborta sin tocar la BD. Las relaciones de ruta de bus en OSM para Santa Cruz suelen ser escasas, así que puede haber menos rutas que paradas.

## Frontend: instalación y comandos

Ejecutar desde `frontend/`:

```bash
npm install
npm run dev        # servidor de desarrollo Vite (puerto 5173 por defecto)
npm run build      # tsc -b && vite build
npm run lint       # eslint .
npm run preview
```
