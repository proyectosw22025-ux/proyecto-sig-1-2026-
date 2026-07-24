"""
Importador de datos REALES de transporte de Santa Cruz desde la API pública
de Microcruz (https://microcruz.tel.bo), al modelo normalizado
LineaMicro -> Ruta -> RutaParada -> Parada.

Fuente mucho más completa que OSM/Overpass para esta ciudad: expone ~147
líneas y ~2000 puntos (paradas/esquinas) con la asociación línea<->punto ya
resuelta por el propio sitio. Estos puntos son paradas VIRTUALES estratégicas
(cerca de colegios, hospitales, esquinas, etc.) — el sistema real de micros de
Santa Cruz no depende de infraestructura física (banca/caseta) en cada una;
por eso se usan tal cual, con sus nombres reales de esquina.

Lógica de mapeo Microcruz -> modelo:
  - Cada nombre de ruta ("linea72", "linea16 Azul", ...) es una LINEA_MICRO.
  - El trazado de cada línea viene como una única polilínea con `seq`
    correlativo; `api/routes.php?action=sentidos` indica en qué rango de
    `seq` está la IDA y en cuál la VUELTA. Cada rango se separa en una RUTA.
    Si no hay rango válido, se crea una única ruta CIRCULAR con todo el trazado.
  - `api/points.php` da los PUNTOS (paradas) de toda la ciudad, con el nombre
    de la esquina y, en `rutasPorPunto`, qué líneas pasan por cada uno.
  - Para asignar un punto a una ruta concreta (ida vs. vuelta) y calcular su
    `orden`, se proyecta sobre el trazado con `LineLocatePoint` (igual que
    hace seed_osm.py) y se asigna a la rama más cercana.

Uso:  python manage.py seed_microcruz  [--timeout 30] [--chunk 20]

Si la API no responde, aborta SIN tocar la BD (usa seed_db o seed_osm).
"""
import re
import time

from django.contrib.gis.db.models.functions import LineLocatePoint
from django.contrib.gis.geos import LineString, Point
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import F

from transit_app.models import LineaMicro, Parada, Ruta, RutaParada

import requests

BASE_URL = "https://microcruz.tel.bo/api"
HEADERS = {"User-Agent": "VisorSIG-SantaCruz/1.0 (proyecto academico)"}

PALETTE = [
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
    "#06b6d4", "#d946ef", "#eab308", "#22c55e", "#0ea5e9",
]

COLOR_WORDS = {
    "azul": "#2563eb", "celeste": "#38bdf8", "rojo": "#dc2626",
    "verde": "#16a34a", "amarillo": "#eab308", "naranja": "#f97316",
    "morado": "#7c3aed", "violeta": "#7c3aed", "rosado": "#ec4899",
    "rosa": "#ec4899", "cafe": "#92400e", "café": "#92400e",
    "marron": "#92400e", "marrón": "#92400e", "negro": "#1f2937",
    "blanco": "#9ca3af", "gris": "#6b7280", "plomo": "#6b7280",
}

# Umbral de cercanía punto<->trazado para decidir a qué rama (ida/vuelta)
# pertenece un punto, en grados (~110 m a la latitud de Santa Cruz).
UMBRAL_PROXIMIDAD_GRADOS = 0.001


class Command(BaseCommand):
    help = "Importa líneas, rutas y paradas reales de Santa Cruz desde la API de Microcruz"

    def add_arguments(self, parser):
        parser.add_argument("--timeout", type=int, default=30,
                             help="Timeout en segundos por petición HTTP")
        parser.add_argument("--chunk", type=int, default=20,
                             help="Cuántas líneas pedir por petición (la propia web usa 20)")

    def handle(self, *args, **options):
        timeout = options["timeout"]
        chunk_size = options["chunk"]

        try:
            route_names = self._get_json("/routes.php?action=list", timeout).get("routes", [])
            points_data = self._get_json("/points.php", timeout)
        except requests.RequestException as exc:
            self.stderr.write(self.style.ERROR(f"Error consultando Microcruz: {exc}"))
            self.stderr.write("No se modificó la base de datos. Usa 'python manage.py seed_db'.")
            return

        if not route_names or not points_data.get("points"):
            self.stderr.write(self.style.ERROR("Microcruz no devolvió datos. No se modificó la BD."))
            return

        self.stdout.write(f"Recibido de Microcruz: {len(route_names)} líneas, "
                           f"{len(points_data['points'])} puntos.")

        geometries, sentidos = {}, {}
        for i in range(0, len(route_names), chunk_size):
            chunk = route_names[i:i + chunk_size]
            names_param = ",".join(chunk)
            try:
                geometries.update(
                    self._get_json(f"/routes.php?names={names_param}", timeout).get("routes", {})
                )
                sentidos.update(
                    self._get_json(f"/routes.php?action=sentidos&names={names_param}", timeout)
                    .get("sentidos", {})
                )
            except requests.RequestException as exc:
                self.stderr.write(self.style.WARNING(
                    f"  Saltado bloque {chunk[0]}..{chunk[-1]}: {exc}"))
            time.sleep(0.2)  # no saturar el servidor de terceros

        with transaction.atomic():
            self.stdout.write("Limpiando datos existentes...")
            LineaMicro.objects.all().delete()
            Parada.objects.all().delete()

            paradas_por_punto_id = self._crear_paradas(points_data["points"])
            rutas_por_nombre = self._crear_lineas_y_rutas(route_names, geometries, sentidos)
            vinculos = self._vincular_paradas(
                route_names, rutas_por_nombre, points_data.get("rutasPorPunto", {}),
                paradas_por_punto_id,
            )

        self.stdout.write(self.style.SUCCESS(
            f"Importación Microcruz completa: {LineaMicro.objects.count()} líneas, "
            f"{Ruta.objects.count()} rutas, {Parada.objects.count()} paradas, "
            f"{vinculos} vínculos ruta-parada."))

    # -----------------------------------------------------------------
    # HTTP
    # -----------------------------------------------------------------

    def _get_json(self, path, timeout):
        resp = requests.get(f"{BASE_URL}{path}", headers=HEADERS, timeout=timeout)
        resp.raise_for_status()
        return resp.json()

    # -----------------------------------------------------------------
    # Paradas (puntos)
    # -----------------------------------------------------------------

    def _crear_paradas(self, points):
        paradas_por_punto_id = {}
        nuevas = []
        for p in points:
            punto_id = p.get("punto")
            lat, lng = p.get("lat"), p.get("lng")
            if punto_id is None or lat is None or lng is None:
                continue
            nombre = p.get("esquinas") or f"Punto {punto_id}"
            nuevas.append(Parada(
                nombre=nombre[:200], codigo=str(punto_id),
                geom=Point(lng, lat, srid=4326),
            ))
        Parada.objects.bulk_create(nuevas)
        for parada in Parada.objects.filter(codigo__in=[str(p["punto"]) for p in points if "punto" in p]):
            paradas_por_punto_id[parada.codigo] = parada
        return paradas_por_punto_id

    # -----------------------------------------------------------------
    # Líneas y rutas (con separación ida/vuelta)
    # -----------------------------------------------------------------

    def _crear_lineas_y_rutas(self, route_names, geometries, sentidos):
        rutas_por_nombre = {}  # nombre microcruz -> lista de Ruta creadas
        color_idx = 0
        for name in route_names:
            seq_points = geometries.get(name)
            if not seq_points:
                continue

            codigo, color_hint = self._parse_codigo_color(name)
            color = color_hint or PALETTE[color_idx % len(PALETTE)]
            if not color_hint:
                color_idx += 1

            linea, _ = LineaMicro.objects.get_or_create(
                codigo=codigo[:20], defaults={"nombre": f"Línea {codigo}"[:120], "color": color},
            )

            ordenado = sorted(seq_points, key=lambda pt: pt["seq"])
            por_seq = {pt["seq"]: (pt["lng"], pt["lat"]) for pt in ordenado}
            info_sentido = sentidos.get(name)

            tramos = self._dividir_en_tramos(por_seq, info_sentido)
            rutas_creadas = []
            for sentido, coords in tramos:
                if len(coords) < 2:
                    continue
                deduped = self._dedupe(coords)
                if len(deduped) < 2:
                    continue
                ruta = Ruta.objects.create(
                    linea=linea, nombre=name[:150], sentido=sentido,
                    geom=LineString(deduped, srid=4326),
                )
                rutas_creadas.append(ruta)
            rutas_por_nombre[name] = rutas_creadas
        return rutas_por_nombre

    @staticmethod
    def _parse_codigo_color(name):
        # "linea72" -> ("72", None); "linea16 Azul" -> ("16 Azul", "#2563eb")
        sin_prefijo = re.sub(r"^linea", "", name, flags=re.IGNORECASE).strip()
        color = None
        for palabra, hex_color in COLOR_WORDS.items():
            if re.search(rf"\b{palabra}\b", sin_prefijo, flags=re.IGNORECASE):
                color = hex_color
                break
        return sin_prefijo or name, color

    @staticmethod
    def _dividir_en_tramos(por_seq, info_sentido):
        """Devuelve [(sentido, [(lng,lat), ...]), ...] a partir del rango ida/vuelta."""
        seqs_disponibles = sorted(por_seq.keys())

        def rango(inicio, fin):
            return [por_seq[s] for s in seqs_disponibles if inicio <= s <= fin]

        if info_sentido:
            ida_ini, ida_fin = info_sentido.get("seq_inicio_ida"), info_sentido.get("seq_fin_ida")
            vta_ini, vta_fin = info_sentido.get("seq_inicio_vuelta"), info_sentido.get("seq_fin_vuelta")
            valido_ida = ida_ini is not None and ida_fin is not None and ida_fin >= ida_ini
            valido_vuelta = vta_ini is not None and vta_fin is not None and vta_fin >= vta_ini
            if valido_ida or valido_vuelta:
                tramos = []
                if valido_ida:
                    tramos.append((Ruta.IDA, rango(ida_ini, ida_fin)))
                if valido_vuelta:
                    tramos.append((Ruta.VUELTA, rango(vta_ini, vta_fin)))
                return tramos

        return [(Ruta.CIRCULAR, [por_seq[s] for s in seqs_disponibles])]

    @staticmethod
    def _dedupe(coords):
        deduped = [coords[0]]
        for c in coords[1:]:
            if c != deduped[-1]:
                deduped.append(c)
        return deduped

    # -----------------------------------------------------------------
    # Vínculo Ruta <-> Parada (con orden a lo largo del trazado)
    # -----------------------------------------------------------------

    def _vincular_paradas(self, route_names, rutas_por_nombre, rutas_por_punto, paradas_por_punto_id):
        # Invertir rutasPorPunto: nombre de línea -> lista de Paradas que la tocan
        paradas_por_linea = {}
        for punto_key, nombres_ruta in rutas_por_punto.items():
            # Las claves vienen como "punto7", no "7"
            punto_id = re.sub(r"^punto", "", str(punto_key), flags=re.IGNORECASE)
            parada = paradas_por_punto_id.get(punto_id)
            if not parada:
                continue
            for nombre in nombres_ruta:
                paradas_por_linea.setdefault(nombre, []).append(parada)

        total_vinculos = 0
        for name in route_names:
            rutas = rutas_por_nombre.get(name) or []
            candidatas = paradas_por_linea.get(name) or []
            if not rutas or not candidatas:
                continue

            # Si hay una sola rama (circular), todas las candidatas van ahí.
            # Si hay ida+vuelta, cada parada se asigna a la rama más cercana.
            asignacion = {ruta.id: [] for ruta in rutas}
            for parada in candidatas:
                mejor_ruta = min(rutas, key=lambda r: r.geom.distance(parada.geom))
                asignacion[mejor_ruta.id].append(parada.id)

            for ruta in rutas:
                ids = asignacion[ruta.id]
                if not ids:
                    continue
                ordenadas = (
                    Parada.objects.filter(id__in=ids)
                    .annotate(pos=LineLocatePoint(ruta.geom, F('geom')))
                    .order_by('pos')
                )
                for orden, parada in enumerate(ordenadas, start=1):
                    RutaParada.objects.create(ruta=ruta, parada=parada, orden=orden)
                    total_vinculos += 1
        return total_vinculos
