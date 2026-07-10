# Despliegue en un VPS (Ubuntu) con Docker

Guía para poner el proyecto en línea en un servidor. Todo corre en contenedores
(base de datos + backend + frontend), así que no se instala Python, Node ni
PostgreSQL en el VPS: solo Docker.

El frontend se sirve con Nginx, que además hace de **reverse proxy** del backend:
el navegador habla con un solo puerto y `/graphql/` se reenvía internamente al
backend. Por eso **no hay que configurar ninguna IP** en el código.

## 1. Requisitos en el VPS (una sola vez)

Conéctate por SSH (`ssh root@TU_IP`) e instala Docker y Git:

```bash
apt update
apt install -y git
curl -fsSL https://get.docker.com | sh      # instala Docker + Docker Compose
docker --version && docker compose version   # verificar
```

## 2. Clonar el proyecto en un directorio dedicado

Para no ensuciar la raíz ni chocar con otros proyectos, se clona en su propia
carpeta bajo `/opt`:

```bash
mkdir -p /opt/visor-sig
git clone -b nilser https://github.com/proyectosw22025-ux/proyecto-sig-1-2026-.git /opt/visor-sig
cd /opt/visor-sig
```

> `-b nilser` clona la rama de trabajo (donde están todos los cambios). Si más
> adelante fusionas a `master`, clona sin `-b nilser`.

## 3. Levantar todo

```bash
docker compose up --build -d                                   # construye y arranca los 3 contenedores
docker compose exec backend python manage.py seed_microcruz   # carga datos reales (solo la 1.ª vez)
```

Listo. El sitio queda accesible en:

```
http://TU_IP:5173/
```

(para este VPS: **http://185.249.227.122:5173/**)

## 4. Comandos útiles

```bash
docker compose ps            # estado de los contenedores
docker compose logs -f       # ver logs en vivo
docker compose down          # apagar (los datos de la BD se conservan)
git pull && docker compose up --build -d   # actualizar tras nuevos cambios
```

## Notas

- **Puertos:** el frontend usa el `5173` y el backend el `8080`. Si ya tienes
  otro proyecto en esos puertos, cámbialos en [docker-compose.yml](docker-compose.yml)
  (ej. `"8090:8080"`), o pon el frontend en el `80` (`"80:80"`) para acceder sin
  `:5173` en la URL — siempre que ese puerto esté libre.
- **Firewall:** si el VPS tiene `ufw` activo, abre el puerto del frontend:
  `ufw allow 5173`.
- **Datos:** viven en un volumen de Docker (`postgres_data`); sobreviven a
  `docker compose down`/`up`. Solo se borran con `docker compose down -v`.
- Esta configuración es para uso académico/demostración (DEBUG activo, sin HTTPS
  ni dominio). Para producción real haría falta un dominio, HTTPS y `DEBUG=False`.
