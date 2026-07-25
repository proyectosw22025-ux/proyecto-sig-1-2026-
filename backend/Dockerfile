FROM python:3.12-slim

# Librerías nativas GDAL/GEOS/PROJ requeridas por GeoDjango
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin libgdal-dev libgeos-dev libproj-dev binutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080

# Arranque en producción (Railway). docker-compose.yml sobrescribe este
# `command` con runserver, así que el desarrollo local no se ve afectado.
# Railway asigna el puerto por la variable PORT; en local cae a 8080.
# Se ejecutan migrate y collectstatic en cada arranque para que un despliegue
# nuevo quede listo sin pasos manuales.
CMD sh -c "python manage.py migrate --noinput && \
    python manage.py collectstatic --noinput && \
    gunicorn transit_project.wsgi:application \
        --bind 0.0.0.0:${PORT:-8080} \
        --workers 2 \
        --timeout 120 \
        --access-logfile -"
