import { factories } from '@strapi/strapi';

/**
 * Core CRUD router. The Public role gets find/findOne (granted in
 * src/cms/bootstrap.ts) because the careers form on the landing reads the list
 * of open cargos anonymously — unlike the applications themselves, which stay
 * admin-only.
 */
export default factories.createCoreRouter('api::job-role.job-role');
