import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Server => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  app: {
    keys: env.array('APP_KEYS'),
  },
  // Enable Strapi's built-in cron runner (jobs defined in config/cron.ts).
  cron: {
    enabled: env.bool('CRON_ENABLED', true),
  },
  // Trust X-Forwarded-* from Caddy so Strapi knows requests arrive over HTTPS
  // and will set Secure cookies (required for the SSO OAuth callback).
  // Strapi 5 reads server.proxy.koa — the boolean form does NOT propagate to koa.
  proxy: {
    koa: env.bool('IS_PROXIED', false),
  },
});

export default config;
