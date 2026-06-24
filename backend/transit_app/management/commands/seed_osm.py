"""
Importador de datos REALES de transporte de Santa Cruz desde OpenStreetMap
(Overpass API), al modelo normalizado LineaMicro -> Ruta -> RutaParada -> Parada.

Lógica de mapeo OSM -> modelo:
  - Cada relación `route=bus` de OSM es una RUTA (un sentido del recorrido).
  - Las relaciones se AGRUPAN por su `ref` (ej. "72") en una LINEA_MICRO; así la
    ida y la vuelta de una misma línea quedan bajo la misma línea comercial.
  - El sentido (IDA/VUELTA) se infiere de las etiquetas/nombre de la relación.
  - Los nodos miembros con rol stop/platform definen las PARADAS y, por su orden
    en la relación, el `orden` de cada parada en la ruta (navegabilidad real).

Uso:  python manage.py seed_osm  [--timeout 180]

Si Overpass falla o no devuelve datos, aborta SIN tocar la BD (usa seed_db).
"""
from django.core.management.base import BaseCommand
from django.contrib.gis.geos import LineString, Point
from django.contrib.gis.db.models.functions import LineLocatePoint
from django.db import transaction
from django.db.models import F
from transit_app.models import LineaMicro, Ruta, Parada, RutaParada
import requests

# Umbral de cercanía parada<->trazado, en grados (~55 m a la latitud de Santa Cruz)
UMBRAL_PROXIMIDAD_GRADOS = 0.0005

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
SCZ_BBOX = (-18.05, -63.35, -17.65, -63.00)  # sur, oeste, norte, este

PALETTE = [
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
    "#06b6d4", "#d946ef", "#eab308", "#22c55e", "#0ea5e9",
]


class Command(BaseCommand):
    help = "Importa líneas, rutas y paradas reales de Santa Cruz desde OpenStreetMap"

    def add_arguments(self, parser):
        parser.add_argument("--timeout", type=int, default=180,
                            help="Timeout en segundos para la consulta Overpass")

    def handle(self, *args, **options):
        timeout = options["timeout"]
        s, w, n, e = SCZ_BBOX
        bbox = f"{s},{w},{n},{e}"
        query = f"""
        [out:json][timeout:{timeout}];
        (
          node["highway"="bus_stop"]({bbox});
          node["public_transport"="platform"]["bus"="yes"]({bbox});
          relation["route"="bus"]({bbox});
        );
        out body geom;
        >;
        out skel qt;
        """

        self.stdout.write(f"Consultando Overpass API ({OVERPASS_URL})...")
        try:
            resp = requests.post(
                OVERPASS_URL, data={"data": query},
                headers={"User-Agent": "VisorSIG-SantaCruz/1.0 (proyecto academico)"},
                timeout=timeout + 30,
            )
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as exc:
            self.stderr.write(self.style.ERROR(f"Error consultando Overpass: {exc}"))
            self.stderr.write("No se modificó la base de datos. Usa 'python manage.py seed_db'.")
            return

        elements = data.get("elements", [])
        relations = [el for el in elements if el.get("type") == "relation"]
        # Mapa de TODOS los nodos con coordenadas (incluye los traídos por el
        # recurse-down `>`), para poder ubicar las paradas miembro de las rutas
        # aunque no tengan etiqueta de bus_stop.
        all_nodes = {
            el["id"]: el for el in elements
            if el.get("type") == "node" and "lat" in el and "lon" in el
        }
        # Paradas "oficiales" (nodos etiquetados como parada de bus)
        stop_nodes = {
            el["id"]: el
            for el in all_nodes.values()
            if (el.get("tags", {}).get("highway") == "bus_stop"
                or el.get("tags", {}).get("public_transport") == "platform")
        }

        if not stop_nodes and not relations:
            self.stderr.write(self.style.ERROR(
                "Overpass no devolvió datos para Santa Cruz. No se modificó la BD."))
            return

        self.stdout.write(
            f"Recibido de OSM: {len(stop_nodes)} paradas candidatas, {len(relations)} rutas.")

        with transaction.atomic():
            self.stdout.write("Limpiando datos existentes...")
            LineaMicro.objects.all().delete()
            Parada.objects.all().delete()

            # --- Paradas (deduplicadas por id de nodo OSM) ---
            osm_to_parada = {}

            def get_or_create_parada(osm_id):
                """Devuelve la Parada del nodo, creándola desde sus coordenadas si hace falta."""
                if osm_id in osm_to_parada:
                    return osm_to_parada[osm_id]
                node = all_nodes.get(osm_id)
                if not node:
                    return None
                nombre = node.get("tags", {}).get("name") or f"Parada s/n ({osm_id})"
                parada = Parada.objects.create(
                    nombre=nombre[:200], geom=Point(node["lon"], node["lat"], srid=4326))
                osm_to_parada[osm_id] = parada
                return parada

            # Crear primero las paradas oficialmente etiquetadas (para que también
            # aparezcan en el mapa aunque no pertenezcan a ninguna relación).
            for osm_id in stop_nodes:
                get_or_create_parada(osm_id)

            # --- Agrupar relaciones por línea (ref) y crear LineaMicro ---
            lineas_cache = {}   # clave de línea -> LineaMicro
            color_idx = 0

            def get_linea(rel_tags):
                nonlocal color_idx
                ref = (rel_tags.get("ref") or "").strip()
                clave = ref if ref else f"OSM-{rel_tags.get('_relid')}"
                if clave not in lineas_cache:
                    nombre = f"Línea {ref}" if ref else (rel_tags.get("name") or f"Línea {clave}")
                    color = rel_tags.get("colour", "")
                    if not (color.startswith("#") and len(color) in (4, 7)):
                        color = PALETTE[color_idx % len(PALETTE)]
                        color_idx += 1
                    lineas_cache[clave] = LineaMicro.objects.create(
                        codigo=clave[:20], nombre=nombre[:120], color=color)
                return lineas_cache[clave]

            rutas_creadas = 0
            for rel in relations:
                tags = dict(rel.get("tags", {}))
                tags["_relid"] = rel["id"]
                coords = self._build_line_coords(rel)
                if len(coords) < 2:
                    continue  # sin geometría utilizable

                linea = get_linea(tags)
                sentido = self._detect_sentido(tags)
                try:
                    ruta = Ruta.objects.create(
                        linea=linea,
                        nombre=tags.get("name", linea.nombre)[:150],
                        sentido=sentido,
                        geom=LineString(coords, srid=4326),
                    )
                except Exception as exc:
                    self.stderr.write(f"  Saltada relación {rel['id']}: {exc}")
                    continue
                rutas_creadas += 1

                # Paradas miembros de la relación, EN ORDEN -> RutaParada.orden.
                # En OSM los nodos miembro de una ruta de bus son sus paradas
                # (rol stop/platform); las creamos si aún no existían.
                orden = 0
                vistas = set()
                for member in rel.get("members", []):
                    ref_id = member.get("ref")
                    if member.get("type") != "node" or ref_id in vistas:
                        continue
                    parada = get_or_create_parada(ref_id)
                    if parada:
                        orden += 1
                        vistas.add(ref_id)
                        RutaParada.objects.create(ruta=ruta, parada=parada, orden=orden)

            # --- Asociación por PROXIMIDAD para rutas sin paradas por membresía ---
            # En OSM las relaciones de bus de Santa Cruz suelen traer solo la
            # geometría (calles), sin listar las paradas. Las inferimos: paradas
            # cercanas al trazado, ordenadas por su posición a lo largo de la línea
            # (ST_LineLocatePoint devuelve la fracción 0..1 sobre el recorrido).
            vinculos_proximidad = 0
            for ruta in Ruta.objects.filter(ruta_paradas__isnull=True).distinct():
                cercanas = (
                    Parada.objects
                    .filter(geom__dwithin=(ruta.geom, UMBRAL_PROXIMIDAD_GRADOS))
                    .annotate(pos=LineLocatePoint(ruta.geom, F('geom')))
                    .order_by('pos')
                )
                for i, parada in enumerate(cercanas, start=1):
                    RutaParada.objects.create(ruta=ruta, parada=parada, orden=i)
                    vinculos_proximidad += 1
            if vinculos_proximidad:
                self.stdout.write(
                    f"Vínculos ruta-parada inferidos por proximidad: {vinculos_proximidad}")

            # --- Descartar paradas sin nombre y sin ninguna ruta ---
            huérfanas = Parada.objects.filter(
                ruta_paradas__isnull=True, nombre__startswith="Parada s/n")
            borradas = huérfanas.count()
            huérfanas.delete()

        self.stdout.write(self.style.SUCCESS(
            f"Importación OSM completa: {LineaMicro.objects.count()} líneas, "
            f"{Ruta.objects.count()} rutas, {Parada.objects.count()} paradas, "
            f"{RutaParada.objects.count()} vínculos ruta-parada."))
        if borradas:
            self.stdout.write(f"(Se descartaron {borradas} paradas sin nombre ni ruta.)")

    @staticmethod
    def _detect_sentido(tags):
        texto = f"{tags.get('name', '')} {tags.get('from', '')} {tags.get('to', '')}".lower()
        if any(k in texto for k in ("vuelta", "regreso", "retorno", "back")):
            return Ruta.VUELTA
        if any(k in texto for k in ("ida", "outbound", "forward")):
            return Ruta.IDA
        return Ruta.CIRCULAR

    def _build_line_coords(self, relation):
        """Ensambla la geometría de la ruta cosiendo los tramos (ways) miembros."""
        segments = []
        for member in relation.get("members", []):
            if member.get("type") != "way":
                continue
            geom = member.get("geometry")
            if not geom:
                continue
            pts = [(p["lon"], p["lat"]) for p in geom if "lon" in p and "lat" in p]
            if len(pts) >= 2:
                segments.append(pts)
        if not segments:
            return []

        ordered = list(segments.pop(0))
        changed = True
        while segments and changed:
            changed = False
            for i, seg in enumerate(segments):
                if seg[0] == ordered[-1]:
                    ordered.extend(seg[1:]); segments.pop(i); changed = True; break
                if seg[-1] == ordered[-1]:
                    ordered.extend(reversed(seg[:-1])); segments.pop(i); changed = True; break
                if seg[-1] == ordered[0]:
                    ordered[0:0] = seg[:-1]; segments.pop(i); changed = True; break
                if seg[0] == ordered[0]:
                    ordered[0:0] = list(reversed(seg))[:-1]; segments.pop(i); changed = True; break
        for seg in segments:
            ordered.extend(seg)

        deduped = [ordered[0]]
        for pt in ordered[1:]:
            if pt != deduped[-1]:
                deduped.append(pt)
        return deduped
