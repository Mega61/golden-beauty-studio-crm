# Handoff — CI/CD de Strapi con GitHub Actions + ghcr.io

## Objetivo

Configurar un pipeline de GitHub Actions en este repo que, en cada push a `master`, construya la imagen Docker de Strapi (usando el `Dockerfile.prod` existente) y la publique en GitHub Container Registry (`ghcr.io`) como imagen **pública**. Luego, el despliegue se hace en Portainer usando esa imagen ya construida (NO se construye en la VM ni vía el agent de Portainer).

Este repo es un proyecto Strapi (creado con `create-strapi`), TypeScript, público, rama por defecto `master`. Ya contiene `Dockerfile.prod`, `docker-compose.yml`, `.env.example` y `.gitignore`.

## Contexto de la arquitectura (no cambiar)

- Strapi corre en una VM de GCP gestionada por Portainer (solo el agent en la VM; servidor central en homelab vía Tailscale).
- **No construir la imagen en la VM ni vía el agent**: el build con BuildKit a través del agent remoto falla (`failed to list workers for Build / http2 frame too large`). Por eso movemos el build a GitHub Actions y la VM solo descarga la imagen.
- Hay un **PostgreSQL compartido** en otro stack (servicio `database`, red Docker `data`, puerto interno 5432, base `strapi`). Strapi se conecta ahí; no lleva su propia BD.
- Dos redes Docker externas: `web` (proxy Caddy ↔ apps) y `data` (apps ↔ BD). Strapi va en ambas. No publica puertos al host (Caddy lo alcanza por `web`).

## Distinción crítica: build-time vs runtime

- **Build-time (va en el pipeline / horneado en la imagen):** `STRAPI_ADMIN_BACKEND_URL`. El Dockerfile lo recibe como `ARG`. Es la URL pública del panel admin (p. ej. `https://cms.DOMINIO`). Se pasa como `build-arg` en el workflow.
- **Runtime (NUNCA en la imagen, NUNCA en el repo):** credenciales de BD y secretos de Strapi (`APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `ENCRYPTION_KEY`). Estos se inyectan en Portainer al desplegar, como variables de entorno del stack. No deben aparecer en ningún archivo del repo ni en la imagen.

## Tareas

### 1. Verificación de seguridad previa (hazla primero y reporta)
- Confirma que `.gitignore` excluye `.env` (el real, no `.env.example`).
- Revisa el historial de los commits (`git log`, `git log --all --full-history -- .env`) para confirmar que **nunca** se subió un `.env` con secretos reales. El repo es PÚBLICO, así que si algún secreto estuvo en el historial, repórtalo: habrá que rotar esas claves. No continúes sin verificar esto.

### 2. Crear el workflow
Crea `.github/workflows/build-and-push.yml`:

```yaml
name: Build and Push Strapi Image

on:
  push:
    branches:
      - master

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./Dockerfile.prod
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
          build-args: |
            STRAPI_ADMIN_BACKEND_URL=https://cms.REEMPLAZAR_DOMINIO
```

Reemplaza `REEMPLAZAR_DOMINIO` por el dominio real cuando se conozca; si aún no está definido, déjalo como placeholder claramente marcado y avísalo en el reporte. NOTA: `secrets.GITHUB_TOKEN` lo provee GitHub automáticamente; no hay que crearlo.

### 3. Verificar que el Dockerfile es compatible
- Confirma que `Dockerfile.prod` está en la raíz y declara `ARG STRAPI_ADMIN_BACKEND_URL` + `ENV STRAPI_ADMIN_BACKEND_URL=...` antes de `npm run build`. (Ya debería; verifícalo.)
- Confirma que la imagen final NO copia ni incluye el archivo `.env`. Revisa `.dockerignore`: debe excluir `.env`, `node_modules`, `.tmp`, `build/`, `.git`.

### 4. Ajustar el compose para desplegar desde la imagen (no build)
Reescribe `docker-compose.yml` (o crea uno para Portainer) para que use la imagen del registro en vez de construir. Sin servicio de BD propio, en redes externas `web` y `data`, sin puertos publicados:

```yaml
services:
  strapi:
    container_name: strapi
    image: ghcr.io/mega61/golden-beauty-studio-crm:latest
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_CLIENT: postgres
      DATABASE_HOST: database
      DATABASE_PORT: 5432
      DATABASE_NAME: strapi
      DATABASE_USERNAME: ${DATABASE_USERNAME}
      DATABASE_PASSWORD: ${DATABASE_PASSWORD}
      APP_KEYS: ${APP_KEYS}
      API_TOKEN_SALT: ${API_TOKEN_SALT}
      ADMIN_JWT_SECRET: ${ADMIN_JWT_SECRET}
      JWT_SECRET: ${JWT_SECRET}
      TRANSFER_TOKEN_SALT: ${TRANSFER_TOKEN_SALT}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
    networks:
      - web
      - data

networks:
  web:
    external: true
  data:
    external: true
```

Las `${...}` se rellenan en Portainer (env vars del stack), no en el repo.

## Pasos manuales que el usuario hará (no los puede hacer Claude Code, solo documéntalos en el reporte)
1. Tras el primer run verde del workflow, hacer la imagen **pública**: GitHub → perfil → Packages → el paquete → Package settings → Change visibility → Public. (Los paquetes nuevos en ghcr.io nacen privados aunque el repo sea público.)
2. En Portainer: desplegar el stack con el compose de arriba e inyectar las variables de runtime (credenciales de BD + claves de Strapi).
3. Al actualizar: push a `master` → el pipeline reconstruye → en Portainer re-deploy con "re-pull image" (con tag `:latest`, hay que forzar el pull para que baje la nueva).

## Restricciones
- No pongas secretos en el workflow, el compose, ni ningún archivo del repo. Solo `STRAPI_ADMIN_BACKEND_URL` (no es secreto) va en el pipeline.
- No reintroduzcas un bloque `build:` en el compose de despliegue; el build vive solo en Actions.
- No agregues un servicio de Postgres al compose de Strapi; usa el `database` compartido.
- Reporta al final: estado de la verificación de seguridad, archivos creados/modificados, y los pasos manuales pendientes para el usuario.
```

## Mejora opcional (solo si el usuario lo pide)
Taguear también con el SHA del commit (`ghcr.io/...:${{ github.sha }}`) además de `latest`, para despliegues más rastreables y evitar el problema de caché de `latest`. No implementar salvo que se solicite.