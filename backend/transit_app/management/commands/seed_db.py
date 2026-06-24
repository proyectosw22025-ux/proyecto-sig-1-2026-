"""
Siembra de datos CURADOS (offline) para el visor de transporte de Santa Cruz.

Puebla el modelo normalizado: LineaMicro -> Ruta -> RutaParada -> Parada.
Datos hechos a mano, deterministas y siempre disponibles (sin red). Útil como
demo de respaldo cuando no se quiere depender de la Overpass API (ver seed_osm).

Uso:  python manage.py seed_db
"""
from django.core.management.base import BaseCommand
from django.contrib.gis.geos import LineString, Point
from django.db import transaction
from transit_app.models import LineaMicro, Ruta, Parada, RutaParada


class Command(BaseCommand):
    help = 'Puebla la BD con datos curados de líneas y paradas de Santa Cruz (offline)'

    @transaction.atomic
    def handle(self, *args, **options):
        self.stdout.write('Limpiando base de datos existente...')
        # CASCADE limpia Ruta y RutaParada al borrar líneas; las paradas aparte.
        LineaMicro.objects.all().delete()
        Parada.objects.all().delete()

        # Cada línea tiene UNA ruta (su recorrido) con su trazado y sentido.
        lineas_data = [
            {"codigo": "72", "nombre": "Línea 72 (Segundo Anillo)", "color": "#3b82f6", "sentido": Ruta.CIRCULAR,
             "coords": [
                 [-63.1812, -17.7685], [-63.1765, -17.7712], [-63.1730, -17.7760], [-63.1705, -17.7820],
                 [-63.1695, -17.7870], [-63.1700, -17.7915], [-63.1750, -17.7955], [-63.1830, -17.7988],
                 [-63.1885, -17.7985], [-63.1938, -17.7952], [-63.1950, -17.7885], [-63.1930, -17.7818],
                 [-63.1915, -17.7770], [-63.1820, -17.7690], [-63.1812, -17.7685],
             ]},
            {"codigo": "73", "nombre": "Línea 73 (Segundo Anillo)", "color": "#ef4444", "sentido": Ruta.CIRCULAR,
             "coords": [
                 [-63.1814, -17.7687], [-63.1822, -17.7692], [-63.1917, -17.7772], [-63.1932, -17.7820],
                 [-63.1952, -17.7887], [-63.1940, -17.7954], [-63.1887, -17.7987], [-63.1832, -17.7990],
                 [-63.1752, -17.7957], [-63.1702, -17.7917], [-63.1697, -17.7872], [-63.1707, -17.7822],
                 [-63.1732, -17.7762], [-63.1767, -17.7714], [-63.1814, -17.7687],
             ]},
            {"codigo": "17", "nombre": "Línea 17 (Radial 26 - Centro)", "color": "#10b981", "sentido": Ruta.IDA,
             "coords": [
                 [-63.1950, -17.7450], [-63.1930, -17.7550], [-63.1910, -17.7650],
                 [-63.1880, -17.7750], [-63.1850, -17.7800], [-63.1812, -17.7863],
             ]},
            {"codigo": "18", "nombre": "Línea 18 (Villa 1ro de Mayo - Centro)", "color": "#f59e0b", "sentido": Ruta.IDA,
             "coords": [
                 [-63.1200, -17.7900], [-63.1350, -17.7880], [-63.1500, -17.7870],
                 [-63.1650, -17.7860], [-63.1750, -17.7860], [-63.1812, -17.7863],
             ]},
            {"codigo": "8", "nombre": "Línea 8 (Plan 3000 - Centro)", "color": "#8b5cf6", "sentido": Ruta.IDA,
             "coords": [
                 [-63.1300, -17.8300], [-63.1450, -17.8200], [-63.1600, -17.8080],
                 [-63.1720, -17.7960], [-63.1770, -17.7900], [-63.1812, -17.7863],
             ]},
        ]

        ruta_por_codigo = {}
        for ld in lineas_data:
            linea = LineaMicro.objects.create(codigo=ld["codigo"], nombre=ld["nombre"], color=ld["color"])
            ruta = Ruta.objects.create(
                linea=linea,
                nombre=ld["nombre"],
                sentido=ld["sentido"],
                geom=LineString(ld["coords"], srid=4326),
            )
            ruta_por_codigo[ld["codigo"]] = ruta
            self.stdout.write(f'Línea creada: {linea.nombre}')

        # Paradas con las líneas (por código) que pasan por ellas.
        paradas_data = [
            {"nombre": "Parada 2do Anillo - Av. Cristo Redentor", "x": -63.1812, "y": -17.7685, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. Mutualista", "x": -63.1765, "y": -17.7712, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. Paraguá", "x": -63.1730, "y": -17.7760, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. Virgen de Cotoca", "x": -63.1705, "y": -17.7820, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. Brasil", "x": -63.1695, "y": -17.7870, "lineas": ["72", "73", "18"]},
            {"nombre": "Parada 2do Anillo - Av. Tres Pasos al Frente", "x": -63.1700, "y": -17.7915, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. San Aurelio", "x": -63.1750, "y": -17.7955, "lineas": ["72", "73", "8"]},
            {"nombre": "Parada 2do Anillo - Av. Santos Dumont", "x": -63.1830, "y": -17.7988, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - El Trompillo", "x": -63.1885, "y": -17.7985, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. Grigotá", "x": -63.1938, "y": -17.7952, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. Landívar", "x": -63.1950, "y": -17.7885, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. Centenario", "x": -63.1930, "y": -17.7818, "lineas": ["72", "73"]},
            {"nombre": "Parada 2do Anillo - Av. Busch", "x": -63.1915, "y": -17.7770, "lineas": ["72", "73", "17"]},
            {"nombre": "Parada 2do Anillo - Av. Banzer", "x": -63.1820, "y": -17.7690, "lineas": ["72", "73"]},
            {"nombre": "Parada Radial 26 - 5to Anillo", "x": -63.1950, "y": -17.7450, "lineas": ["17"]},
            {"nombre": "Parada Radial 26 - 4to Anillo", "x": -63.1930, "y": -17.7550, "lineas": ["17"]},
            {"nombre": "Parada Radial 26 - 3er Anillo", "x": -63.1910, "y": -17.7650, "lineas": ["17"]},
            {"nombre": "Parada Villa 1ro de Mayo - Plaza", "x": -63.1200, "y": -17.7900, "lineas": ["18"]},
            {"nombre": "Parada 3 Pasos al Frente - Villa", "x": -63.1350, "y": -17.7880, "lineas": ["18"]},
            {"nombre": "Parada 3 Pasos al Frente - 3er Anillo", "x": -63.1500, "y": -17.7870, "lineas": ["18"]},
            {"nombre": "Parada Plan 3000 - Rotonda Obelisco", "x": -63.1300, "y": -17.8300, "lineas": ["8"]},
            {"nombre": "Parada Av. Paurito - Hospital", "x": -63.1450, "y": -17.8200, "lineas": ["8"]},
            {"nombre": "Parada Av. San Aurelio - 4to Anillo", "x": -63.1600, "y": -17.8080, "lineas": ["8"]},
            {"nombre": "Parada Central - Plaza 24 de Septiembre", "x": -63.1812, "y": -17.7863, "lineas": ["17", "18", "8"]},
            {"nombre": "Parada Central - Correo Anexo", "x": -63.1800, "y": -17.7840, "lineas": ["17", "18"]},
            {"nombre": "Parada Central - Av. Las Américas", "x": -63.1770, "y": -17.7900, "lineas": ["8"]},
        ]

        # Contador de orden por ruta (secuencia de paradas en el recorrido)
        orden_por_ruta = {codigo: 0 for codigo in ruta_por_codigo}
        for pd in paradas_data:
            parada = Parada.objects.create(nombre=pd["nombre"], geom=Point(pd["x"], pd["y"], srid=4326))
            for codigo in pd["lineas"]:
                ruta = ruta_por_codigo.get(codigo)
                if ruta:
                    orden_por_ruta[codigo] += 1
                    RutaParada.objects.create(ruta=ruta, parada=parada, orden=orden_por_ruta[codigo])

        self.stdout.write(self.style.SUCCESS(
            f'Datos curados cargados: {LineaMicro.objects.count()} líneas, '
            f'{Ruta.objects.count()} rutas, {Parada.objects.count()} paradas, '
            f'{RutaParada.objects.count()} vínculos ruta-parada.'
        ))
