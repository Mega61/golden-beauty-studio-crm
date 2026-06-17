import type { Core } from '@strapi/strapi';

/**
 * Scheduled jobs. Enabled via `server.cron.enabled` in config/server.ts.
 * Daily win-back reconciler at 06:00 America/Bogota: recomputes every Visit's
 * next_recommended_date (picks up cadence edits) and refreshes each Client's
 * denormalized countdown so the status rolls over as days pass. See plan §1.4 / §5.
 */
const crons = {
  winbackDailyRecompute: {
    task: async ({ strapi }: { strapi: Core.Strapi }) => {
      await strapi.service('api::visit.winback').recomputeAll();
    },
    options: {
      rule: '0 6 * * *',
      tz: 'America/Bogota',
    },
  },
};

export default crons;
