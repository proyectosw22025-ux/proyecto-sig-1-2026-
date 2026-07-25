"""
Importador HÍBRIDO de transporte real de Santa Cruz:
  - RUTAS (trazado, líneas, ida/vuelta) desde la API pública de Microcruz
    (https://microcruz.tel.bo) — ~147 líneas reales, mucho más completo que OSM.
  - PARADAS desde OpenStreetMap/Overpass — solo nodos etiquetados
    explícitamente como `highway=bus_stop` o `public_transport=platform`,
    es decir paradas físicas reales (con caseta/señalética), NO cualquier
    esquina. Microcruz expone ~2000 "puntos" que son en realidad nodos de su
    grafo de calles para el buscador de rutas, no paradas físicas — de ahí
    que no se usen como fuente de paradas.

Al modelo normalizado LineaMicro -> Ruta -> RutaParada -> Parada.

Lógica de mapeo:
  - Cada nombre de ruta de Microcruz ("linea72", "linea16 Azul", ...) es una
    LINEA_MICRO. El trazado viene como una polilínea con `seq` correlativo;
    `api/routes.php?action=sentidos` indica en qué rango de `seq` está la IDA
    y en cuál la VUELTA. Cada rango se separa en una RUTA. Si no hay rango
    válido, se crea una única ruta CIRCULAR con todo el trazado.
  - Las paradas (nodos OSM) se vinculan a cada Ruta por CERCANÍA geométrica
    al trazado (dwithin) y se ordenan a lo largo de él con `LineLocatePoint`,
    igual que hace seed_osm.py.

Uso:  python manage.py seed_microcruz  [--timeout 30] [--chunk 20] [--osm-timeout 60]

Si alguna de las dos fuentes no responde, aborta SIN tocar la BD (usa seed_db).
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

MICROCRUZ_BASE_URL = "https://microcruz.tel.bo/api"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
SCZ_BBOX = (-18.05, -63.35, -17.65, -63.00)  # sur, oeste, norte, este
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

# Umbral de cercanía parada<->trazado para vincularlas, en grados
# (~165 m a la latitud de Santa Cruz). Más laxo que seed_osm.py porque aquí
# las paradas (OSM) y el trazado (Microcruz) vienen de fuentes distintas y
# no siempre coinciden con precisión de metro.
UMBRAL_PROXIMIDAD_GRADOS = 0.0015


class Command(BaseCommand):
    help = ("Importa rutas reales de Microcruz + paradas físicas reales de OSM, "
            "vinculadas por cercanía geométrica")

    def add_arguments(self, parser):
        parser.add_argument("--timeout", type=int, default=30,
                             help="Timeout en segundos por petición a Microcruz")
        parser.add_argument("--chunk", type=int, default=20,
                             help="Cuántas líneas pedir por petición a Microcruz")
        parser.add_argument("--osm-timeout", type=int, default=60,
                             help="Timeout en segundos para la consulta Overpass")

    def handle(self, *args, **options):
        timeout = options["timeout"]
        chunk_size = options["chunk"]
        osm_timeout = options["osm_timeout"]

        try:
            route_names = self._get_json(f"{MICROCRUZ_BASE_URL}/routes.php?action=list", timeout).get("routes", [])
        except requests.RequestException as exc:
            self.stderr.write(self.style.ERROR(f"Error consultando Microcruz: {exc}"))
            self.stderr.write("No se modificó la base de datos.")
            return

        if not route_names:
            self.stderr.write(self.style.ERROR("Microcruz no devolvió líneas. No se modificó la BD."))
            return

        try:
            stop_nodes = self._fetch_osm_paradas(osm_timeout)
        except requests.RequestException as exc:
            self.stderr.write(self.style.ERROR(f"Error consultando Overpass: {exc}"))
            self.stderr.write("No se modificó la base de datos.")
            return

        if not stop_nodes:
            self.stderr.write(self.style.ERROR("Overpass no devolvió paradas. No se modificó la BD."))
            return

        self.stdout.write(f"Recibido: {len(route_names)} líneas (Microcruz), "
                           f"{len(stop_nodes)} paradas físicas reales (OSM).")

        geometries, sentidos = {}, {}
        for i in range(0, len(route_names), chunk_size):
            chunk = route_names[i:i + chunk_size]
            names_param = ",".join(chunk)
            try:
                geometries.update(
                    self._get_json(f"{MICROCRUZ_BASE_URL}/routes.php?names={names_param}", timeout)
                    .get("routes", {})
                )
                sentidos.update(
                    self._get_json(
                        f"{MICROCRUZ_BASE_URL}/routes.php?action=sentidos&names={names_param}", timeout
                    ).get("sentidos", {})
                )
            except requests.RequestException as exc:
                self.stderr.write(self.style.WARNING(
                    f"  Saltado bloque {chunk[0]}..{chunk[-1]}: {exc}"))
            time.sleep(0.2)  # no saturar el servidor de terceros

        with transaction.atomic():
            self.stdout.write("Limpiando datos existentes...")
            LineaMicro.objects.all().delete()
            Parada.objects.all().delete()

            self._crear_paradas(stop_nodes)
            self._crear_lineas_y_rutas(route_names, geometries, sentidos)
            vinculos = self._vincular_por_cercania()
            # Una parada por la que no pasa NINGUNA línea no sirve en el mapa:
            # se borra (tenga o no nombre). Debe ir ANTES del renombrado.
            borradas = self._borrar_paradas_sin_lineas()
            renombradas = self._nombrar_sin_nombre()

        self.stdout.write(self.style.SUCCESS(
            f"Importación completa: {LineaMicro.objects.count()} líneas, "
            f"{Ruta.objects.count()} rutas, {Parada.objects.count()} paradas, "
            f"{vinculos} vínculos ruta-parada."))
        if renombradas or borradas:
            self.stdout.write(
                f"Limpieza de paradas: {borradas} borradas (0 líneas pasan por ahí), "
                f"{renombradas} sin nombre renombradas por sus líneas.")

    # -----------------------------------------------------------------
    # HTTP
    # -----------------------------------------------------------------

    def _get_json(self, url, timeout):
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        resp.raise_for_status()
        return resp.json()

    def _fetch_osm_paradas(self, timeout):
        s, w, n, e = SCZ_BBOX
        bbox = f"{s},{w},{n},{e}"
        query = f"""
        [out:json][timeout:{timeout}];
        (
          node["highway"="bus_stop"]({bbox});
          node["public_transport"="platform"]["bus"="yes"]({bbox});
        );
        out body;
        """
        resp = requests.post(
            OVERPASS_URL, data={"data": query}, headers=HEADERS, timeout=timeout + 30,
        )
        resp.raise_for_status()
        data = resp.json()
        return [el for el in data.get("elements", []) if el.get("type") == "node"]

    # -----------------------------------------------------------------
    # Paradas (nodos OSM reales)
    # -----------------------------------------------------------------

    # Prefijo temporal para paradas SIN nombre en OSM; luego se reemplaza por
    # un nombre derivado de las líneas que pasan (ver _nombrar_sin_nombre).
    SIN_NOMBRE_PREFIX = "__sin_nombre__"

    def _crear_paradas(self, stop_nodes):
        nuevas = []
        vistos = set()
        for node in stop_nodes:
            osm_id = node["id"]
            if osm_id in vistos:
                continue
            vistos.add(osm_id)
            nombre = node.get("tags", {}).get("name")
            # Sin nombre en OSM -> marcador temporal (no el id crudo, que parece código)
            nombre = nombre or f"{self.SIN_NOMBRE_PREFIX}{osm_id}"
            nuevas.append(Parada(
                nombre=nombre[:200], codigo=str(osm_id),
                geom=Point(node["lon"], node["lat"], srid=4326),
            ))
        Parada.objects.bulk_create(nuevas)

    # -----------------------------------------------------------------
    # Líneas y rutas (con separación ida/vuelta)
    # -----------------------------------------------------------------

    def _crear_lineas_y_rutas(self, route_names, geometries, sentidos):
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
            for sentido, coords in tramos:
                if len(coords) < 2:
                    continue
                deduped = self._dedupe(coords)
                if len(deduped) < 2:
                    continue
                Ruta.objects.create(
                    linea=linea, nombre=name[:150], sentido=sentido,
                    geom=LineString(deduped, srid=4326),
                )

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
    # Vínculo Ruta <-> Parada por cercanía geométrica (orden a lo largo del trazado)
    # -----------------------------------------------------------------

    def _vincular_por_cercania(self):
        total_vinculos = 0
        for ruta in Ruta.objects.all():
            cercanas = (
                Parada.objects
                .filter(geom__dwithin=(ruta.geom, UMBRAL_PROXIMIDAD_GRADOS))
                .annotate(pos=LineLocatePoint(ruta.geom, F('geom')))
                .order_by('pos')
            )
            for orden, parada in enumerate(cercanas, start=1):
                RutaParada.objects.create(ruta=ruta, parada=parada, orden=orden)
                total_vinculos += 1
        return total_vinculos

    # -----------------------------------------------------------------
    # Limpieza y nombres de paradas
    # -----------------------------------------------------------------

    def _borrar_paradas_sin_lineas(self):
        """Borra las paradas por las que no pasa ninguna línea (sin vínculos)."""
        huerfanas = Parada.objects.filter(ruta_paradas__isnull=True)
        borradas = huerfanas.count()
        huerfanas.delete()
        return borradas

    def _nombrar_sin_nombre(self):
        """
        Renombra las paradas OSM que no tenían `name` (quedaron con un marcador
        temporal) a "Parada Línea X" / "Parada Líneas X, Y" según las líneas
        distintas que pasan por ellas. Se ejecuta DESPUÉS de borrar las que no
        tienen ninguna línea, así que aquí todas tienen al menos una.
        Devuelve la cantidad de paradas renombradas.
        """
        renombradas = 0
        sin_nombre = Parada.objects.filter(nombre__startswith=self.SIN_NOMBRE_PREFIX)
        for parada in sin_nombre:
            codigos = list(
                LineaMicro.objects.filter(rutas__paradas__id=parada.id)
                .distinct().order_by('codigo').values_list('codigo', flat=True)
            )
            if not codigos:
                continue  # no debería pasar (ya se borraron las de 0 líneas)
            if len(codigos) == 1:
                parada.nombre = f"Parada Línea {codigos[0]}"
            else:
                mostrados = ", ".join(codigos[:3])
                extra = f" +{len(codigos) - 3}" if len(codigos) > 3 else ""
                parada.nombre = f"Parada Líneas {mostrados}{extra}"
            parada.save(update_fields=["nombre"])
            renombradas += 1
        return renombradas
