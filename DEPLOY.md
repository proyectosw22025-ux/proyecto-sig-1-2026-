# Despliegue

El proyecto está publicado en la nube con **Railway** (backend + base de datos) y
**Vercel** (frontend). Ambos servicios están conectados a este repositorio, así
que **cada push a `master` redespliega automáticamente**.

| Qué | URL |
| --- | --- |
| Aplicación (esto es lo que se comparte) | https://visor-sig.vercel.app |
| API GraphQL | https://backend-production-1166.up.railway.app/graphql/ |

## Cómo encajan las piezas

```
              GitHub (master)
             /               \
      auto-deploy           auto-deploy
          v                      v
  Vercel (frontend)   ----> Railway (backend)
  React + Vite               Django + gunicorn
  rewrite /graphql/                 |
                                    v
                            Railway (db)
                            PostGIS 16-3.4 + volumen
```

El navegador **nunca llama al backend directamente**: pide `/graphql/` al mismo
origen que sirve la página y Vercel lo reenvía a Railway mediante el rewrite de
[frontend/vercel.json](frontend/vercel.json). Es el mismo truco que usa Nginx en
el VPS y el proxy de Vite en local, y por eso no hay CORS que configurar ni URLs
del backend incrustadas en el código.

## Railway (backend + base de datos)

Proyecto `visor-sig`, con dos servicios:

- **`db`** — imagen `postgis/postgis:16-3.4`. El Postgres gestionado de Railway
  **no incluye PostGIS**, y sin esa extensión los campos geométricos no
  funcionan; de ahí que se despliegue la imagen oficial en vez del template.
  Tiene un **volumen** montado en `/var/lib/postgresql/data`: sin él los datos se
  perderían en cada redespliegue.
- **`backend`** — se construye desde [backend/Dockerfile](backend/Dockerfile).
  El ajuste clave es **Root Directory = `/backend`**: sin eso Railway intenta
  compilar desde la raíz del repo, no sabe si mirar `backend/` o `frontend/` y
  el build falla.

Variables de entorno del servicio `backend` (se consultan con
`railway variables --service backend`):

| Variable | Para qué |
| --- | --- |
| `DATABASE_URL` | Apunta al servicio `db` por la red privada (`db.railway.internal`) |
| `DEBUG` | `False` en producción |
| `SECRET_KEY` | Clave de Django; nunca se commitea |
| `ALLOWED_HOSTS` | Hosts que Django acepta |

El contenedor ejecuta `migrate` y `collectstatic` en cada arranque, así que un
despliegue nuevo queda listo sin pasos manuales.

### Cargar los datos (solo la primera vez)

```bash
railway ssh --service backend python manage.py seed_microcruz
```

> El seeder descarga en vivo de `microcruz.tel.bo` y `overpass-api.de`; **los
> datos no están en el repositorio**. Overpass se satura con frecuencia y
> responde `504`: si pasa, el seeder aborta **sin tocar la base** y basta con
> reintentar (a veces hacen falta varios intentos). El plan B offline es
> `seed_db`, con datos curados pero muchos menos.

`railway ssh` necesita una clave SSH registrada: `railway ssh keys add`.

## Vercel (frontend)

Proyecto `visor-sig`. Dos ajustes importantes:

- **Root Directory = `frontend`** — el `package.json` vive ahí, no en la raíz.
  Con el valor por defecto (`.`) el build falla al no encontrarlo.
- El rewrite de `/graphql/` en [frontend/vercel.json](frontend/vercel.json)
  declara las tres formas de la ruta (sin barra, con barra y con subruta) porque
  un único patrón `/graphql/:path*` no llega a coincidir con la petición real
  del frontend, que es exactamente `/graphql/`, y Vercel devuelve 404.

Para publicar a mano sin pasar por git: `cd frontend && vercel --prod`.

## Instalarla como aplicación (móvil y escritorio)

El frontend es una **PWA**, así que no hace falta ningún `.apk` ni tienda de
aplicaciones:

- **Android:** abrir la URL en Chrome → menú ⋮ → *Instalar aplicación*
- **Windows / macOS:** Chrome o Edge → icono de instalar en la barra de direcciones

Queda con su propio icono, se abre en ventana sin barra del navegador y funciona
sin conexión (cachea los tiles del mapa y las respuestas del backend). Como carga
desde Vercel, **se actualiza sola con cada push**: no hay que reinstalar nada.

---

# Alternativa: despliegue en un VPS con Docker

Todo corre en contenedores (base de datos + backend + frontend), así que en el
servidor solo se instala Docker.

## 1. Requisitos en el VPS (una sola vez)

```bash
apt update
apt install -y git
curl -fsSL https://get.docker.com | sh      # instala Docker + Docker Compose
docker --version && docker compose version   # verificar
```

## 2. Clonar el proyecto

```bash
mkdir -p /opt/visor-sig
git clone https://github.com/proyectosw22025-ux/proyecto-sig-1-2026-.git /opt/visor-sig
cd /opt/visor-sig
```

## 3. Levantar todo

```bash
docker compose up --build -d                                  # construye y arranca los 3 contenedores
docker compose exec backend python manage.py seed_microcruz   # carga datos reales (solo la 1.ª vez)
```

El sitio queda en `http://TU_IP:5173/`.

## 4. Comandos útiles

```bash
docker compose ps            # estado de los contenedores
docker compose logs -f       # ver logs en vivo
docker compose down          # apagar (los datos de la BD se conservan)
git pull && docker compose up --build -d   # actualizar tras nuevos cambios
```

## Notas

- **Puertos:** el frontend usa el `5173` y el backend el `8080`. Se cambian en
  [docker-compose.yml](docker-compose.yml) (ej. `"80:80"` para acceder sin el
  `:5173` en la URL).
- **Firewall:** si el VPS tiene `ufw` activo: `ufw allow 5173`.
- **Datos:** viven en el volumen `postgres_data` y sobreviven a
  `docker compose down`/`up`. Solo se borran con `docker compose down -v`.
