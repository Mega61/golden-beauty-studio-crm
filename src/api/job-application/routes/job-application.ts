import { factories } from '@strapi/strapi';

/**
 * Core CRUD router. The Public role is deliberately granted NO permission on
 * these routes (see PUBLIC_READ_UIDS in src/cms/bootstrap.ts) — applications
 * hold personal data and are admin-only. Public submissions come in through the
 * secret-gated POST /api/job-applications/apply route (routes/apply.ts).
 */
export default factories.createCoreRouter('api::job-application.job-application');
