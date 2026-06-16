import type { Core } from '@strapi/strapi';
import { seedServiceCadences } from './winback/cadence-seed';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * Seeds the ServiceCadence config (idempotent).
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await seedServiceCadences(strapi);
  },
};
