# Handoff — SSO de Google (Workspace) en el panel admin de Strapi

## Objetivo

Configurar login con Google en el **panel de administración** de Strapi usando el plugin comunitario `strapi-plugin-sso` (de yasudacloud), restringido **exclusivamente** a las cuentas del Google Workspace del dominio `goldenbeautystudio.com.co`. Esto permite que la editora entre con su correo empresarial sin contraseña local.

Contexto: proyecto Strapi 5, TypeScript, repo público, rama `master`. La imagen se construye vía GitHub Actions y se publica en ghcr.io; el deploy es en Portainer sobre una VM (Strapi en `https://cms.goldenbeautystudio.com.co`, detrás de Caddy). Ver handoffs previos de CI/CD para ese flujo.

## Seguridad — por qué el blindaje por dominio NO es opcional

Este plugin tiene una debilidad conocida y documentada: cualquiera que conozca la URL de SSO podría intentar registrarse, y existe riesgo de apropiación de cuenta por email. La mitigación obligatoria es restringir el login a un dominio de Google Workspace con `GOOGLE_GSUITE_HD`. SIN esta restricción, no se debe habilitar el SSO. El dominio a usar es `goldenbeautystudio.com.co`. Además, la OAuth consent screen se configurará como "Internal" (paso manual del usuario), lo que añade una segunda capa de restricción a nivel de Google.

## Tareas (en el repo)

### 1. Instalar el plugin
- Ejecuta `npm install strapi-plugin-sso`.
- Verifica en `package.json` que la versión instalada sea **>= 1.0.7** (requisito de compatibilidad con Strapi 5.24.1+). Si npm instaló una anterior, fija explícitamente una versión 1.0.7 o superior. Reporta la versión final.

### 2. Configurar el plugin
- El proyecto es TypeScript, así que edita/crea `config/plugins.ts` (no `.js`). Si ya existe `config/plugins.ts` con otra config, **fusiona** sin borrar lo existente; no lo sobrescribas.
- Agrega la configuración del plugin con esta forma (adaptando a sintaxis TS del proyecto):

```typescript
export default ({ env }) => ({
  'strapi-plugin-sso': {
    enabled: true,
    config: {
      GOOGLE_OAUTH_CLIENT_ID: env('GOOGLE_OAUTH_CLIENT_ID'),
      GOOGLE_OAUTH_CLIENT_SECRET: env('GOOGLE_OAUTH_CLIENT_SECRET'),
      GOOGLE_OAUTH_REDIRECT_URI: 'https://cms.goldenbeautystudio.com.co/strapi-plugin-sso/google/callback',
      GOOGLE_GSUITE_HD: 'goldenbeautystudio.com.co',
    },
  },
});
```

- `GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET` se leen de variables de entorno (son secretos de runtime; se inyectan en Portainer, NO en el repo).
- `GOOGLE_GSUITE_HD` queda hardcodeado al dominio (no es secreto) y es la restricción de seguridad clave.
- `GOOGLE_OAUTH_REDIRECT_URI` debe coincidir EXACTAMENTE con la redirect URI que se registre en Google Cloud, carácter por carácter (causa #1 de fallo: `redirect_uri_mismatch`).

### 3. Verificaciones
- Confirma que `.env.example` documente las dos nuevas variables (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`) SIN valores reales, para referencia.
- Confirma que ningún valor real de Client ID/Secret quede en el repo ni en el `.env.example`.
- Confirma que el `Dockerfile.prod` reconstruirá con el plugin incluido (el plugin entra vía `npm ci` / `package.json`, no requiere cambios en el Dockerfile, pero verifícalo).
- No toques el flujo de CI/CD existente más allá de lo necesario; el plugin se hornea en la imagen automáticamente al reconstruir.

## Pasos manuales del usuario (documéntalos en el reporte; Claude Code NO los hace)

1. **Google Cloud Console** → APIs & Services → OAuth consent screen → tipo **Internal** (restringe a Workspace). Luego Credentials → Create OAuth client ID → tipo **Web application**.
2. En **Authorized redirect URIs** registrar exactamente:
   `https://cms.goldenbeautystudio.com.co/strapi-plugin-sso/google/callback`
3. Copiar el **Client ID** y **Client Secret** generados.
4. En **Portainer**, en el stack de Strapi, agregar dos variables de entorno: `GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET` con esos valores. Re-deploy.
5. Tras desplegar, en el panel admin de Strapi (sección del plugin SSO) definir el **rol por defecto** para usuarios SSO: usar **Editor** (no Super Admin), para que la editora gestione contenido sin acceso a configuración crítica.
6. Verificar que `STRAPI_ADMIN_BACKEND_URL` (build-arg del pipeline) sea `https://cms.goldenbeautystudio.com.co`, coherente con el redirect URI.

## Flujo de despliegue
Commit + push a `master` → GitHub Actions reconstruye la imagen con el plugin → en Portainer inyectar las 2 variables nuevas y re-deploy con re-pull de imagen.

## Restricciones
- NO omitir `GOOGLE_GSUITE_HD`; es la defensa de seguridad central.
- NO poner Client ID/Secret en ningún archivo del repo.
- NO asignar Super Admin como rol por defecto del SSO.
- Mantener el login local (email/contraseña) habilitado como respaldo, por si el SSO falla tras una actualización del plugin (es un plugin de un solo mantenedor). No deshabilitar el acceso local.
- Reportar al final: versión del plugin instalada, archivos modificados, y la lista de pasos manuales pendientes.