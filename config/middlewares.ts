import type { Core } from '@strapi/strapi';

// Media is served from GCS / a Cloudflare-fronted subdomain. The admin panel's
// content-manager previews are blocked by the default CSP unless those origins
// are whitelisted for img/media. Comma-separated list in MEDIA_CSP_ORIGINS,
// e.g. "https://media.goldenbeautystudio.com.co,https://storage.googleapis.com".
const mediaOrigins = (process.env.MEDIA_CSP_ORIGINS ?? 'https://storage.googleapis.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Origins allowed to call the content API from the browser. Server-side fetches
// (Next.js SSR/ISR) are exempt from CORS; this covers client-side use and the
// preview iframe. Comma-separated CORS_ORIGINS overrides the defaults.
const corsOrigins = (
  process.env.CORS_ORIGINS ??
  'https://goldenbeautystudio.com.co,https://www.goldenbeautystudio.com.co,http://localhost:3000'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': ["'self'", 'data:', 'blob:', 'market-assets.strapi.io', ...mediaOrigins],
          'media-src': ["'self'", 'data:', 'blob:', 'market-assets.strapi.io', ...mediaOrigins],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  {
    name: 'strapi::cors',
    config: {
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  {
    name: 'strapi::body',
    config: {
      formLimit: '25mb',
      jsonLimit: '25mb',
      textLimit: '25mb',
      formidable: {
        maxFileSize: 25 * 1024 * 1024,
      },
    },
  },
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];

export default config;
