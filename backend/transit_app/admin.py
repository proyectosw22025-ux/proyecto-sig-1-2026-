from django.contrib.gis import admin
from .models import LineaMicro, Ruta, Parada, RutaParada


class RutaInline(admin.TabularInline):
    model = Ruta
    extra = 0


class RutaParadaInline(admin.TabularInline):
    model = RutaParada
    extra = 0
    ordering = ('orden',)
    autocomplete_fields = ('parada',)


@admin.register(LineaMicro)
class LineaMicroAdmin(admin.ModelAdmin):
    list_display = ('codigo', 'nombre', 'color')
    search_fields = ('codigo', 'nombre')
    inlines = [RutaInline]


@admin.register(Ruta)
class RutaAdmin(admin.GISModelAdmin):
    list_display = ('linea', 'sentido', 'nombre')
    list_filter = ('sentido', 'linea')
    search_fields = ('nombre', 'linea__nombre', 'linea__codigo')
    inlines = [RutaParadaInline]


@admin.register(Parada)
class ParadaAdmin(admin.GISModelAdmin):
    list_display = ('nombre', 'codigo')
    search_fields = ('nombre', 'codigo')
