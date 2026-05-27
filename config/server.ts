import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Server => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  app: {
    keys: env.array('APP_KEYS'),
  },
  // Trust X-Forwarded-* from Caddy so Strapi knows requests arrive over HTTPS
  // and will set Secure cookies (required for the SSO OAuth callback).
  proxy: env.bool('IS_PROXIED', false),
});

export default config;
