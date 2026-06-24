import strawberry
import math
from typing import List, Optional
from .models import LineaMicro, Ruta, Parada
from django.contrib.gis.geos import Point
from django.contrib.gis.db.models.functions import Distance


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distancia real sobre la esfera terrestre (Haversine), en metros."""
    R = 6371000  # Radio medio de la Tierra en metros
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


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
        color=ruta.linea.color,
        sentido=ruta.sentido,
        geom_geojson=ruta.geom.geojson if ruta.geom else "",
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
# Query raíz
# ---------------------------------------------------------------------------

@strawberry.type
class Query:
    @strawberry.field
    def stops(self) -> List[StopType]:
        return [_stop_type(p) for p in Parada.objects.all()]

    @strawberry.field
    def routes(self) -> List[RouteType]:
        return [_route_type(r) for r in Ruta.objects.select_related('linea').all()]

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
        return [_route_type(r) for r in qs.distinct()]

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
