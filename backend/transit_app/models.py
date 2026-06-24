from django.contrib.gis.db import models


class LineaMicro(models.Model):
    """
    Línea comercial de micro (ej. "Línea 72"). Es la entidad que el usuario
    reconoce. Agrupa una o más rutas (típicamente ida y vuelta).
    """
    codigo = models.CharField(max_length=20, unique=True)          # "72"
    nombre = models.CharField(max_length=120)                      # "Línea 72"
    color = models.CharField(max_length=7, default='#3b82f6')      # Hex para el mapa

    class Meta:
        ordering = ['codigo']
        verbose_name = 'Línea de micro'
        verbose_name_plural = 'Líneas de micro'

    def __str__(self):
        return self.nombre


class Parada(models.Model):
    """Parada física de transporte público (un punto geográfico)."""
    nombre = models.CharField(max_length=200)
    codigo = models.CharField(max_length=30, blank=True, null=True)  # Código oficial si existe
    geom = models.PointField(srid=4326)                             # Ubicación (EPSG:4326)

    class Meta:
        ordering = ['nombre']

    def __str__(self):
        return self.nombre


class Ruta(models.Model):
    """
    Recorrido concreto de una línea, con su trazado espacial. Una línea suele
    tener una ruta de ida y otra de vuelta (o una circular).
    """
    IDA = 'IDA'
    VUELTA = 'VUELTA'
    CIRCULAR = 'CIRCULAR'
    SENTIDOS = [(IDA, 'Ida'), (VUELTA, 'Vuelta'), (CIRCULAR, 'Circular')]

    linea = models.ForeignKey(LineaMicro, on_delete=models.CASCADE, related_name='rutas')
    nombre = models.CharField(max_length=150)
    sentido = models.CharField(max_length=10, choices=SENTIDOS, default=CIRCULAR)
    geom = models.LineStringField(srid=4326)                       # Trazado del recorrido
    # M2M con orden explícito a través de la tabla puente RutaParada
    paradas = models.ManyToManyField(Parada, through='RutaParada', related_name='rutas')

    class Meta:
        ordering = ['linea__codigo', 'sentido']

    def __str__(self):
        return f"{self.linea.nombre} ({self.get_sentido_display()})"


class RutaParada(models.Model):
    """
    Tabla puente que ordena las paradas a lo largo de una ruta. El campo `orden`
    es lo que da navegabilidad: secuencia del recorrido, próxima parada, etc.
    """
    ruta = models.ForeignKey(Ruta, on_delete=models.CASCADE, related_name='ruta_paradas')
    parada = models.ForeignKey(Parada, on_delete=models.CASCADE, related_name='ruta_paradas')
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ['orden']
        unique_together = ('ruta', 'parada')
        verbose_name = 'Parada de ruta'
        verbose_name_plural = 'Paradas de ruta'

    def __str__(self):
        return f"{self.ruta} · #{self.orden} · {self.parada}"
