import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  'strapi-plugin-sso': {
    enabled: true,
    config: {
      GOOGLE_OAUTH_CLIENT_ID: env('GOOGLE_OAUTH_CLIENT_ID'),
      GOOGLE_OAUTH_CLIENT_SECRET: env('GOOGLE_OAUTH_CLIENT_SECRET'),
      GOOGLE_OAUTH_REDIRECT_URI: env(
        'GOOGLE_OAUTH_REDIRECT_URI',
        'https://cms.goldenbeautystudio.com.co/strapi-plugin-sso/google/callback'
      ),
      GOOGLE_GSUITE_HD: 'goldenbeautystudio.com.co',
    },
  },
});

export default config;
