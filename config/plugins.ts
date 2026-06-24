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

  // Bilingual marketing content (lookbook labels, promos, pricing names, bio).
  // Locales (es default + en) are ensured idempotently in src/index.ts bootstrap.
  i18n: {
    enabled: true,
  },

  // Media library → Google Cloud Storage. When GCS_BUCKET_NAME is unset (e.g.
  // local dev), Strapi falls back to its default local-disk provider so the
  // app still boots. In prod, set the GCS_* vars (see docs/GCP-CLOUDFLARE-SETUP.md).
  ...(env('GCS_BUCKET_NAME')
    ? {
        upload: {
          config: {
            provider:
              '@strapi-community/strapi-provider-upload-google-cloud-storage',
            providerOptions: {
              bucketName: env('GCS_BUCKET_NAME'),
              // Omit serviceAccount to use the VM's Application Default
              // Credentials; set GCS_SERVICE_ACCOUNT (a JSON key) to use a
              // dedicated service-account key instead.
              serviceAccount: env.json('GCS_SERVICE_ACCOUNT', undefined),
              // Public delivery URL. Point at the Cloudflare-fronted subdomain
              // (e.g. https://media.goldenbeautystudio.com.co) for CDN caching.
              // Falls back to the raw GCS URL when unset.
              baseUrl: env(
                'GCS_BASE_URL',
                `https://storage.googleapis.com/${env('GCS_BUCKET_NAME')}`
              ),
              basePath: env('GCS_BASE_PATH', ''),
              publicFiles: env.bool('GCS_PUBLIC_FILES', true),
              // Uniform bucket-level access (recommended): permissions are
              // managed by IAM, not per-object ACLs.
              uniform: env.bool('GCS_UNIFORM', true),
              skipCheckBucket: env.bool('GCS_SKIP_CHECK_BUCKET', false),
              gzip: 'auto',
              cacheMaxAge: env.int('GCS_CACHE_MAX_AGE', 86400),
            },
            // Allow raw phone photos (the default 200 KB cap is far too small).
            sizeLimit: env.int('UPLOAD_SIZE_LIMIT', 25 * 1024 * 1024),
          },
        },
      }
    : {}),
});

export default config;
