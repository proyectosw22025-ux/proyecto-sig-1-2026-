import strawberry
import math
import colorsys
from typing import List, Optional
from .models import LineaMicro, Ruta, Parada
from django.contrib.gis.geos import Point
from django.contrib.gis.db.models.functions import Distance


def _color_for_ruta(ruta_id: int) -> str:
    """
    Color único y estable por ruta. Usa el ángulo áureo sobre el matiz (HSL)
    para repartir colores bien diferenciados, de modo que aunque dos rutas
    pertenezcan a la misma línea (ej. 3 recorridos de la Línea 1) se distingan.
    """
    hue = ((ruta_id * 137.508) % 360) / 360.0
    r, g, b = colorsys.hls_to_rgb(hue, 0.55, 0.62)
    return '#{:02x}{:02x}{:02x}'.format(int(r * 255), int(g * 255), int(b * 255))


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distancia real sobre la esfera terrestre (Haversine), en metros."""
    R = 6371000  # Radio medio de la Tierra en metros
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# Velocidades promedio para ESTIMAR tiempos de viaje (no son exactas). El micro
# en Santa Cruz avanza lento por el tráfico y las paradas frecuentes; se usa una
# velocidad operativa típica de transporte urbano en ciudades latinoamericanas.
WALK_SPEED_MS = 4.8 * 1000 / 3600     # ~1.33 m/s (caminata urbana, ~4.8 km/h)
BUS_SPEED_MS = 15.0 * 1000 / 3600     # ~4.17 m/s (micro con tráfico y paradas, ~15 km/h)
# Caminata máxima aceptable para un transbordo (bajarse de una línea y tomar otra)
TRANSFER_WALK_M = 350.0
# Radio de acceso: caminata máxima hasta la primera parada / desde la última
ACCESS_WALK_M = 800.0
DEG_PER_M = 1 / 111000.0              # metros -> grados aprox. a la latitud de Santa Cruz


def _route_length_m(ruta: Ruta) -> float:
    """Longitud geodésica del trazado (metros), sumando haversine entre vértices."""
    coords = ruta.geom.coords if ruta.geom else ()
    total = 0.0
    for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
        total += haversine_meters(y1, x1, y2, x2)
    return total


def _fraction_along(ruta: Ruta, point: Point) -> float:
    """Fracción 0..1 donde `point` se proyecta sobre el trazado de la ruta."""
    largo_deg = ruta.geom.length
    if largo_deg == 0:
        return 0.0
    return ruta.geom.project(point) / largo_deg


def _nearest_stop_on_route(ruta: Ruta, lat: float, lng: float):
    """Parada de la ruta más cercana a (lat,lng); devuelve (Parada, metros) o (None, None)."""
    mejor, mejor_d = None, None
    for rp in ruta.ruta_paradas.all():
        p = rp.parada
        d = haversine_meters(lat, lng, p.geom.y, p.geom.x)
        if mejor_d is None or d < mejor_d:
            mejor, mejor_d = p, d
    return mejor, mejor_d


def _closest_stop_pair(ruta_a: Ruta, ruta_b: Ruta):
    """Par de paradas (una en cada ruta) con la menor distancia a pie entre ellas."""
    mejor = None  # (parada_a, parada_b, metros)
    for rpa in ruta_a.ruta_paradas.all():
        pa = rpa.parada
        for rpb in ruta_b.ruta_paradas.all():
            pb = rpb.parada
            d = haversine_meters(pa.geom.y, pa.geom.x, pb.geom.y, pb.geom.x)
            if mejor is None or d < mejor[2]:
                mejor = (pa, pb, d)
    return mejor


# ---------------------------------------------------------------------------
# Tipos GraphQL
# ---------------------------------------------------------------------------

@strawberry.type
class LineaType:
    """Resumen de una línea (lo que muestra el popup/listado de una parada)."""
    id: strawberry.ID
    codigo: str
    name: str   # nombre de la línea (mantiene el contrato del frontend)
    color: str


@strawberry.type
class RouteType:
    """Una ruta concreta (ida/vuelta) lista para dibujar en el mapa."""
    id: strawberry.ID
    name: str            # "Línea 72 (Ida)"
    color: str           # color de la línea
    sentido: str
    geom_geojson: str
    stop_ids: List[strawberry.ID]  # IDs de las paradas de esta ruta (para resaltarlas)


@strawberry.type
class StopType:
    """Una parada. `routes` expone las líneas distintas que pasan por ella."""
    id: strawberry.ID
    name: str
    latitude: float
    longitude: float
    distance: Optional[float] = None  # Metros, solo en closestStop

    @strawberry.field
    def routes(self) -> List[LineaType]:
        # Líneas (no rutas) distintas que pasan por esta parada
        lineas = LineaMicro.objects.filter(rutas__paradas__id=self.id).distinct()
        return [
            LineaType(id=l.id, codigo=l.codigo, name=l.nombre, color=l.color)
            for l in lineas
        ]


@strawberry.type
class RutaParadaType:
    """Parada dentro de una ruta, con su posición en la secuencia."""
    orden: int
    parada: StopType


@strawberry.type
class RutaDetalleType:
    """Ruta con su recorrido ordenado de paradas (navegabilidad)."""
    id: strawberry.ID
    name: str
    sentido: str
    color: str
    geom_geojson: str
    paradas: List[RutaParadaType]


@strawberry.type
class TripLeg:
    """Un tramo en micro del viaje: subir a una línea en una parada y bajar en otra."""
    route: RouteType
    board_stop: StopType      # dónde subir
    alight_stop: StopType     # dónde bajar
    ride_distance_m: float
    ride_minutes: float


@strawberry.type
class TripOption:
    """
    Una opción de viaje entre origen y destino: directa (1 tramo en micro) o
    con transbordo (2 tramos + una caminata intermedia). Incluye tiempos
    ESTIMADOS a partir de velocidades promedio (ver planTrip).
    """
    transfers: int            # 0 = directa, 1 = un transbordo
    legs: List[TripLeg]       # 1 tramo (directa) o 2 (con transbordo)
    walk_distance_m: float    # total a pie (acceso + transbordo + salida)
    walk_minutes: float
    ride_minutes: float       # total en micro
    total_minutes: float
    exact: bool               # False = aproximación (fallback, ninguna línea sirve bien)


@strawberry.type
class LineaDetalleType:
    """Línea con todas sus rutas (jerarquía Línea -> Rutas -> Paradas)."""
    id: strawberry.ID
    codigo: str
    name: str
    color: str
    rutas: List[RutaDetalleType]


# ---------------------------------------------------------------------------
# Helpers de mapeo ORM -> GraphQL
# ---------------------------------------------------------------------------

def _route_type(ruta: Ruta) -> RouteType:
    display = ruta.linea.nombre
    if ruta.sentido != Ruta.CIRCULAR:
        display = f"{ruta.linea.nombre} ({ruta.get_sentido_display()})"
    return RouteType(
        id=ruta.id,
        name=display,
        color=_color_for_ruta(ruta.id),   # color único por ruta (no por línea)
        sentido=ruta.sentido,
        geom_geojson=ruta.geom.geojson if ruta.geom else "",
        stop_ids=[str(rp.parada_id) for rp in ruta.ruta_paradas.all()],
    )


def _stop_type(parada: Parada, distance: Optional[float] = None) -> StopType:
    return StopType(
        id=parada.id,
        name=parada.nombre,
        latitude=parada.geom.y,
        longitude=parada.geom.x,
        distance=distance,
    )


# ---------------------------------------------------------------------------
# Construcción de opciones de viaje (directa / con transbordo)
# ---------------------------------------------------------------------------

def _ride_leg(ruta: Ruta, board: Parada, alight: Parada) -> TripLeg:
    """Un tramo en micro entre dos paradas de la misma ruta, con su tiempo estimado."""
    f_board = _fraction_along(ruta, board.geom)
    f_alight = _fraction_along(ruta, alight.geom)
    dist = abs(f_alight - f_board) * _route_length_m(ruta)
    return TripLeg(
        route=_route_type(ruta),
        board_stop=_stop_type(board),
        alight_stop=_stop_type(alight),
        ride_distance_m=round(dist, 1),
        ride_minutes=round(dist / BUS_SPEED_MS / 60, 1),
    )


def _direct_option(ruta: Ruta, o_lat, o_lng, d_lat, d_lng, exact=True) -> Optional[TripOption]:
    """Opción directa: subir a `ruta` cerca del origen y bajar cerca del destino."""
    board, walk_o = _nearest_stop_on_route(ruta, o_lat, o_lng)
    alight, walk_d = _nearest_stop_on_route(ruta, d_lat, d_lng)
    if not board or not alight or board.id == alight.id:
        return None
    leg = _ride_leg(ruta, board, alight)
    walk_m = walk_o + walk_d
    walk_min = walk_m / WALK_SPEED_MS / 60
    return TripOption(
        transfers=0, legs=[leg],
        walk_distance_m=round(walk_m, 1),
        walk_minutes=round(walk_min, 1),
        ride_minutes=leg.ride_minutes,
        total_minutes=round(walk_min + leg.ride_minutes, 1),
        exact=exact,
    )


def _transfer_option(ruta_a: Ruta, ruta_b: Ruta, o_lat, o_lng, d_lat, d_lng) -> Optional[TripOption]:
    """Opción con transbordo: `ruta_a` desde el origen, caminata, `ruta_b` al destino."""
    board_a, walk_o = _nearest_stop_on_route(ruta_a, o_lat, o_lng)
    alight_b, walk_d = _nearest_stop_on_route(ruta_b, d_lat, d_lng)
    par = _closest_stop_pair(ruta_a, ruta_b)
    if not board_a or not alight_b or not par:
        return None
    alight_a, board_b, transfer_m = par
    if transfer_m > TRANSFER_WALK_M:
        return None
    if board_a.id == alight_a.id or board_b.id == alight_b.id:
        return None  # no avanzaría en alguna de las dos líneas
    leg1 = _ride_leg(ruta_a, board_a, alight_a)
    leg2 = _ride_leg(ruta_b, board_b, alight_b)
    walk_m = walk_o + transfer_m + walk_d
    walk_min = walk_m / WALK_SPEED_MS / 60
    ride_min = leg1.ride_minutes + leg2.ride_minutes
    return TripOption(
        transfers=1, legs=[leg1, leg2],
        walk_distance_m=round(walk_m, 1),
        walk_minutes=round(walk_min, 1),
        ride_minutes=round(ride_min, 1),
        total_minutes=round(walk_min + ride_min, 1),
        exact=True,
    )


# ---------------------------------------------------------------------------
# Query raíz
# ---------------------------------------------------------------------------

@strawberry.type
class Query:
    @strawberry.field
    def stops(self) -> List[StopType]:
        return [_stop_type(p) for p in Parada.objects.all()]

    @strawberry.field
    def routes(self) -> List[RouteType]:
        qs = Ruta.objects.select_related('linea').prefetch_related('ruta_paradas')
        return [_route_type(r) for r in qs.all()]

    @strawberry.field
    def lineas(self) -> List[LineaDetalleType]:
        # Jerarquía completa para navegación Línea -> Rutas -> Paradas ordenadas
        result = []
        for linea in LineaMicro.objects.prefetch_related('rutas').all():
            rutas = []
            for ruta in linea.rutas.all():
                paradas = [
                    RutaParadaType(orden=rp.orden, parada=_stop_type(rp.parada))
                    for rp in ruta.ruta_paradas.select_related('parada').all()
                ]
                rutas.append(RutaDetalleType(
                    id=ruta.id,
                    name=str(ruta),
                    sentido=ruta.sentido,
                    color=linea.color,
                    geom_geojson=ruta.geom.geojson if ruta.geom else "",
                    paradas=paradas,
                ))
            result.append(LineaDetalleType(
                id=linea.id, codigo=linea.codigo, name=linea.nombre,
                color=linea.color, rutas=rutas,
            ))
        return result

    @strawberry.field
    def search_stops(self, query: str) -> List[StopType]:
        qs = Parada.objects.filter(nombre__icontains=query)
        return [_stop_type(p) for p in qs]

    @strawberry.field
    def search_routes(self, query: str) -> List[RouteType]:
        # Busca por nombre o código de la línea
        qs = Ruta.objects.select_related('linea').filter(
            linea__nombre__icontains=query
        ) | Ruta.objects.select_related('linea').filter(
            linea__codigo__icontains=query
        )
        qs = qs.distinct().prefetch_related('ruta_paradas')
        return [_route_type(r) for r in qs]

    @strawberry.field
    def plan_trip(
        self,
        origin_lat: float, origin_lng: float,
        dest_lat: float, dest_lng: float,
        radius_m: float = 500.0,
    ) -> List[TripOption]:
        """
        Planifica el viaje origen -> destino y devuelve opciones ordenadas por
        tiempo estimado (el más rápido primero). Cada opción trae los tiempos
        ESTIMADOS a pie y en micro (ver WALK_SPEED_MS / BUS_SPEED_MS).

        Estrategia (se COMBINAN y se ordenan por tiempo total, más rápido primero):
          1. DIRECTAS: líneas cuyo recorrido pasa cerca (radius_m, ampliable) del
             origen Y del destino. Una sola línea.
          2. TRANSBORDOS: una línea desde el origen + otra hasta el destino que se
             crucen a poca distancia a pie (dos líneas). Aparecen cuando resultan
             más rápidos que una directa lejana.
          3. Si no hay ni directas ni transbordos, FALLBACK aproximado: las líneas
             más cercanas a ambos puntos, marcadas exact=False (nunca deja sin
             opciones mientras existan rutas en la BD).
        No considera sentidos de circulación (pensado para peatones).
        """
        origin = Point(origin_lng, origin_lat, srid=4326)
        dest = Point(dest_lng, dest_lat, srid=4326)
        base_qs = (
            Ruta.objects.select_related('linea')
            .prefetch_related('ruta_paradas__parada')
            .annotate(dist_origen=Distance('geom', origin), dist_destino=Distance('geom', dest))
        )

        # --- 1. Directas: pasa cerca de ambos puntos (radio ampliable) ---
        radio = radius_m
        directas = []
        for _ in range(4):  # ej. 500m, 1000m, 2000m, 4000m
            deg = radio * DEG_PER_M
            directas = list(
                base_qs.filter(geom__dwithin=(origin, deg)).filter(geom__dwithin=(dest, deg))
            )
            if directas:
                break
            radio *= 2

        opciones = [
            o for o in (
                _direct_option(r, origin_lat, origin_lng, dest_lat, dest_lng)
                for r in directas
            ) if o
        ]

        # --- 2. Transbordos: línea cerca del origen + línea cerca del destino ---
        acc_deg = ACCESS_WALK_M * DEG_PER_M
        cerca_origen = list(base_qs.filter(geom__dwithin=(origin, acc_deg)).order_by('dist_origen')[:12])
        cerca_destino = list(base_qs.filter(geom__dwithin=(dest, acc_deg)).order_by('dist_destino')[:12])

        transbordos = {}  # (linea_a, linea_b) -> mejor TripOption por tiempo
        for a in cerca_origen:
            for b in cerca_destino:
                if a.id == b.id or a.linea_id == b.linea_id:
                    continue
                opt = _transfer_option(a, b, origin_lat, origin_lng, dest_lat, dest_lng)
                if not opt:
                    continue
                clave = (a.linea_id, b.linea_id)
                if clave not in transbordos or opt.total_minutes < transbordos[clave].total_minutes:
                    transbordos[clave] = opt
        opciones.extend(transbordos.values())

        if opciones:
            opciones.sort(key=lambda o: o.total_minutes)
            return opciones[:8]

        # --- 3. Fallback aproximado: las líneas más cercanas a ambos puntos ---
        todas = list(base_qs)
        if not todas:
            return []
        mejores = sorted(todas, key=lambda r: r.dist_origen.m + r.dist_destino.m)[:3]
        fallback = [
            o for o in (
                _direct_option(r, origin_lat, origin_lng, dest_lat, dest_lng, exact=False)
                for r in mejores
            ) if o
        ]
        fallback.sort(key=lambda o: o.total_minutes)
        return fallback

    @strawberry.field
    def closest_stop(self, latitude: float, longitude: float) -> Optional[StopType]:
        user_point = Point(longitude, latitude, srid=4326)
        closest = Parada.objects.annotate(
            distance=Distance('geom', user_point)
        ).order_by('distance').first()
        if closest:
            meters = haversine_meters(latitude, longitude, closest.geom.y, closest.geom.x)
            return _stop_type(closest, distance=round(meters, 1))
        return None


schema = strawberry.Schema(query=Query)
