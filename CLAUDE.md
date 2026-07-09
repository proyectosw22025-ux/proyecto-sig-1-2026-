# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

GIS web app ("proyecto SIG") that maps public-transit bus lines and stops for **Santa Cruz de la Sierra, Bolivia**. A GeoDjango + PostGIS backend exposes a GraphQL API; a React + Leaflet frontend renders the interactive map. Code comments and user-facing strings are in Spanish.

## Architecture

Two independent apps that talk over GraphQL:

- **`backend/`** — Django 5/6 project `transit_project`, single app `transit_app`.
  - **Normalized spatial model** (GTFS-inspired) in [transit_app/models.py](backend/transit_app/models.py): `LineaMicro` (commercial line: codigo/nombre/color) → `Ruta` (one recorrido per direction: `sentido` IDA/VUELTA/CIRCULAR + `LineStringField`, FK to línea) → `RutaParada` (ordered through-table with `orden`) → `Parada` (`PointField`). All geometry SRID 4326, `(longitude, latitude)` order. The `orden` field is what enables route navigability (stop sequence, next stop).
  - GraphQL is **Strawberry** (not Graphene), defined in [transit_app/schema.py](backend/transit_app/schema.py). Resolvers manually map ORM objects to `@strawberry.type` classes (helpers `_route_type`/`_stop_type`). The API contract is intentionally decoupled from the DB model: `routes` returns `Ruta` variants (with `stopIds`, the stop IDs along that route, for highlighting), `stops` returns `Parada` whose `routes` field resolves to the distinct **líneas** through it. Queries: `stops`, `routes`, `lineas` (full Línea→Ruta→Parada hierarchy for navigation), `searchStops`, `searchRoutes`, `closestStop`, `routesBetween`. `closestStop` orders by PostGIS `Distance` and reports real meters via `haversine_meters`. `routesBetween(originLat, originLng, destLat, destLng, radiusM=500)` finds routes passing within `radiusM` of **both** origin and destination (via PostGIS `dwithin`) — pedestrian-oriented trip planning, ignores direction of travel.
  - Strawberry auto-camelCases field names: Python `geom_geojson` is queried as `geomGeojson` from the client.
  - Single endpoint mounted at `/graphql/` in [transit_project/urls.py](backend/transit_project/urls.py), wrapped in `csrf_exempt` — **required**, or React's POSTs get 403.
- **`frontend/`** — Vite + React 19 + TypeScript, map UI in the single-file [src/App.tsx](frontend/src/App.tsx) (~690 lines, Leaflet + markercluster). All GraphQL access goes through the hand-written fetch wrapper in [src/services/graphql.ts](frontend/src/services/graphql.ts); shared types in [src/types.ts](frontend/src/types.ts). Two more services call **external, key-less OSM services** directly from the browser: [src/services/geocoding.ts](frontend/src/services/geocoding.ts) (Nominatim — address text → lat/lng, bounded to the Santa Cruz viewbox) and [src/services/routing.ts](frontend/src/services/routing.ts) (OSRM `routed-foot` — walking directions between two points, falls back to a straight line if the service doesn't respond).

### Cross-cutting gotchas

- **Backend port must be 8080.** The frontend hardcodes `http://localhost:8080/graphql/` in [src/services/graphql.ts](frontend/src/services/graphql.ts), but Django defaults to 8000. Run the server with `runserver 8080` (or change the constant). There is no proxy config in [vite.config.ts](frontend/vite.config.ts).
- CORS is wide open for dev (`CORS_ALLOW_ALL_ORIGINS = True`) in [settings.py](backend/transit_project/settings.py); CSRF trusts ports 5173/5174.
- DB credentials, `SECRET_KEY`, and `DEBUG=True` are committed in [settings.py](backend/transit_project/settings.py) — this is a local/academic setup, not production.

## Backend setup & commands

### Option A — Docker (recommended for a second machine / teammate)

`docker-compose.yml` (repo root) runs PostGIS + the Django backend in containers, so no native Postgres/GDAL install is needed:

```bash
docker compose up --build              # starts db (postgis/postgis:16-3.4) + backend, runs migrate automatically
docker compose exec backend python manage.py seed_db     # or seed_osm — same seeders as native
```

Backend is reachable at `http://localhost:8080/graphql/` same as native. [backend/transit_project/settings.py](backend/transit_project/settings.py) reads `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_PORT` from the environment (compose sets `DB_HOST=db`), falling back to the hardcoded local defaults when unset — native setup below is unaffected.

### Option B — Native

Requires **PostgreSQL with the PostGIS extension** (DB `transporte_db`, user `postgres`) and the native **GDAL/GEOS** libraries. On Windows, [settings.py](backend/transit_project/settings.py) auto-locates them under `C:\Program Files\PostgreSQL\17\bin` (`libgdal-35.dll`, `libgeos_c.dll`) — adjust that path if PostgreSQL is installed elsewhere.

Run from `backend/` with the venv active (`venv\Scripts\activate` on Windows). Note `backend/venv/` is gitignored — each machine creates its own with `python -m venv venv`:

```bash
pip install -r requirements.txt        # Django, strawberry-graphql[django], psycopg2-binary, requests, django-cors-headers
python manage.py migrate               # apply schema (PostGIS)
python manage.py seed_db               # WIPES and reseeds with CURATED demo data (offline)
python manage.py seed_osm              # WIPES and imports REAL OSM data via Overpass API
         # must be 8080 — see gotcha above
python manage.py test                  # tests (transit_app/tests.py is currently empty)
```

Two seeders, both **delete all existing Stops and Routes first**:

- `seed_db` ([commands/seed_db.py](backend/transit_app/management/commands/seed_db.py)) — 5 hardcoded lines + stops. Offline, deterministic; use as the reliable demo/fallback.
- `seed_osm` ([commands/seed_osm.py](backend/transit_app/management/commands/seed_osm.py)) — real bus stops/lines for Santa Cruz from the **Overpass API** (`requests`). Assembles route relations' member ways into a `LineString` via greedy stitching, links stops by relation membership. Aborts without touching the DB if Overpass fails or returns nothing. Note OSM bus-route relations for SCZ may be sparse, so routes may be fewer than stops.

## Frontend setup & commands

Run from `frontend/`:

```bash
npm install
npm run dev        # Vite dev server (default port 5173)
npm run build      # tsc -b && vite build
npm run lint       # eslint .
npm run preview
```
