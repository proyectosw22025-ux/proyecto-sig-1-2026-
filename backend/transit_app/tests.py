"""
Tests del backend SIG de transporte de Santa Cruz (modelo normalizado).

Cubren:
  - Haversine (distancia en metros).
  - Modelos espaciales y jerarquía LineaMicro -> Ruta -> RutaParada -> Parada.
  - Esquema GraphQL: stops, routes, lineas, búsquedas y parada más cercana.
  - Que /graphql/ NO devuelva 403 (regresión del bug de CSRF).

Ejecutar:  python manage.py test
"""
import json
from django.test import TestCase, Client
from django.contrib.gis.geos import LineString, Point

from transit_app.models import LineaMicro, Ruta, Parada, RutaParada
from transit_app.schema import schema, haversine_meters


class HaversineTest(TestCase):
    def test_distancia_cero(self):
        self.assertAlmostEqual(haversine_meters(-17.78, -63.18, -17.78, -63.18), 0.0, places=3)

    def test_distancia_conocida(self):
        d = haversine_meters(-17.7863, -63.1812, -17.7953, -63.1812)
        self.assertGreater(d, 900)
        self.assertLess(d, 1100)

    def test_simetria(self):
        a = haversine_meters(-17.78, -63.18, -17.79, -63.19)
        b = haversine_meters(-17.79, -63.19, -17.78, -63.18)
        self.assertAlmostEqual(a, b, places=6)


class ModeloNormalizadoTest(TestCase):
    def setUp(self):
        self.linea = LineaMicro.objects.create(codigo="72", nombre="Línea 72", color="#3b82f6")
        self.ruta = Ruta.objects.create(
            linea=self.linea, nombre="Línea 72 Ida", sentido=Ruta.IDA,
            geom=LineString([(-63.18, -17.78), (-63.19, -17.79)], srid=4326),
        )
        self.p1 = Parada.objects.create(nombre="Parada A", geom=Point(-63.18, -17.78, srid=4326))
        self.p2 = Parada.objects.create(nombre="Parada B", geom=Point(-63.19, -17.79, srid=4326))
        RutaParada.objects.create(ruta=self.ruta, parada=self.p1, orden=1)
        RutaParada.objects.create(ruta=self.ruta, parada=self.p2, orden=2)

    def test_jerarquia_linea_ruta(self):
        self.assertEqual(self.linea.rutas.count(), 1)
        self.assertEqual(self.ruta.linea.codigo, "72")

    def test_paradas_ordenadas(self):
        paradas = list(self.ruta.ruta_paradas.all())  # ordering = ['orden']
        self.assertEqual([rp.orden for rp in paradas], [1, 2])
        self.assertEqual(paradas[0].parada.nombre, "Parada A")

    def test_parada_conoce_sus_rutas(self):
        self.assertEqual(self.p1.rutas.count(), 1)
        self.assertEqual(self.p1.rutas.first().linea.nombre, "Línea 72")

    def test_unique_together_ruta_parada(self):
        from django.db import IntegrityError, transaction
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                RutaParada.objects.create(ruta=self.ruta, parada=self.p1, orden=3)

    def test_cascade_borra_rutas(self):
        self.linea.delete()
        self.assertEqual(Ruta.objects.count(), 0)
        self.assertEqual(RutaParada.objects.count(), 0)
        self.assertEqual(Parada.objects.count(), 2)  # las paradas no se borran


class SchemaGraphQLTest(TestCase):
    def setUp(self):
        self.l8 = LineaMicro.objects.create(codigo="8", nombre="Línea 8", color="#8b5cf6")
        self.l72 = LineaMicro.objects.create(codigo="72", nombre="Línea 72", color="#3b82f6")
        self.r8 = Ruta.objects.create(
            linea=self.l8, nombre="Línea 8 Ida", sentido=Ruta.IDA,
            geom=LineString([(-63.182, -17.786), (-63.180, -17.790)], srid=4326))
        self.r72 = Ruta.objects.create(
            linea=self.l72, nombre="Línea 72 Circular", sentido=Ruta.CIRCULAR,
            geom=LineString([(-63.181, -17.768), (-63.176, -17.771)], srid=4326))
        self.plaza = Parada.objects.create(
            nombre="Parada Plaza 24 de Septiembre", geom=Point(-63.1812, -17.7863, srid=4326))
        self.norte = Parada.objects.create(
            nombre="Parada Norte", geom=Point(-63.1812, -17.7685, srid=4326))
        RutaParada.objects.create(ruta=self.r8, parada=self.plaza, orden=1)
        RutaParada.objects.create(ruta=self.r72, parada=self.norte, orden=1)

    def _exec(self, query, variables=None):
        result = schema.execute_sync(query, variable_values=variables or {})
        self.assertIsNone(result.errors, msg=str(result.errors))
        return result.data

    def test_query_stops(self):
        data = self._exec("{ stops { id name latitude longitude } }")
        self.assertEqual(len(data["stops"]), 2)

    def test_query_routes_con_geojson(self):
        data = self._exec("{ routes { id name color sentido geomGeojson } }")
        self.assertEqual(len(data["routes"]), 2)
        self.assertIn("LineString", data["routes"][0]["geomGeojson"])

    def test_stop_routes_devuelve_lineas(self):
        data = self._exec('{ stops { name routes { id name color } } }')
        plaza = next(s for s in data["stops"] if "Plaza" in s["name"])
        self.assertEqual(plaza["routes"][0]["name"], "Línea 8")
        self.assertEqual(plaza["routes"][0]["color"], "#8b5cf6")

    def test_lineas_navegabilidad_jerarquia(self):
        data = self._exec(
            "{ lineas { codigo name rutas { sentido paradas { orden parada { name } } } } }")
        l8 = next(l for l in data["lineas"] if l["codigo"] == "8")
        self.assertEqual(l8["rutas"][0]["paradas"][0]["orden"], 1)
        self.assertIn("Plaza", l8["rutas"][0]["paradas"][0]["parada"]["name"])

    def test_search_stops(self):
        data = self._exec("query($q: String!){ searchStops(query: $q){ name } }", {"q": "plaza"})
        self.assertEqual(len(data["searchStops"]), 1)

    def test_search_routes_por_codigo(self):
        data = self._exec("query($q: String!){ searchRoutes(query: $q){ name } }", {"q": "72"})
        self.assertEqual(len(data["searchRoutes"]), 1)

    def test_closest_stop_metros(self):
        data = self._exec(
            "query($lat: Float!, $lng: Float!){ closestStop(latitude: $lat, longitude: $lng){ name distance } }",
            {"lat": -17.7863, "lng": -63.1812})
        self.assertEqual(data["closestStop"]["name"], "Parada Plaza 24 de Septiembre")
        self.assertLess(data["closestStop"]["distance"], 5)


class EndpointHTTPTest(TestCase):
    """Regresión del bug 403/CSRF en el endpoint real."""

    def setUp(self):
        self.client = Client()
        Parada.objects.create(nombre="Parada HTTP", geom=Point(-63.18, -17.78, srid=4326))

    def test_post_graphql_no_devuelve_403(self):
        resp = self.client.post(
            "/graphql/",
            data=json.dumps({"query": "{ stops { name } }"}),
            content_type="application/json",
        )
        self.assertNotEqual(resp.status_code, 403, "El endpoint volvió a bloquear por CSRF")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["data"]["stops"][0]["name"], "Parada HTTP")
