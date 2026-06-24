import type { Core } from '@strapi/strapi';
import { seedServiceCadences } from './winback/cadence-seed';
import { registerWatermark } from './extensions/upload-watermark';
import { bootstrapCms } from './cms/bootstrap';
import { seedLookbook } from './cms/lookbook-seed';

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
   * Seeds the ServiceCadence config and the public marketing CMS — upload
   * watermarking, locales, public read access, and first-run lookbook content.
   * All steps are idempotent.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await seedServiceCadences(strapi);
    registerWatermark(strapi);
    await bootstrapCms(strapi);
    await seedLookbook(strapi);
  },
};
