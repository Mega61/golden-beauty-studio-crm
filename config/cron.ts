import type { Core } from '@strapi/strapi';

const JOB_APPLICATION_UID = 'api::job-application.job-application';

/** Retention window for job applications, in days. 0 / unset = keep forever. */
function retentionDays(): number {
  const n = Number(process.env.CAREERS_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Scheduled jobs. Enabled via `server.cron.enabled` in config/server.ts.
 *
 *  · winbackDailyRecompute — 06:00 America/Bogota: recomputes every Visit's
 *    next_recommended_date (picks up cadence edits) and refreshes each Client's
 *    denormalized countdown so the status rolls over as days pass. Plan §1.4 / §5.
 *  · careersRetentionPurge — 03:30 America/Bogota: deletes job applications past
 *    the retention window along with their CVs. Colombia's Ley 1581 de 2012 says
 *    personal data may only be kept as long as the purpose requires it, and a
 *    rejected applicant's resume has no purpose a year later. OFF by default —
 *    set CAREERS_RETENTION_DAYS to switch it on (e.g. 365).
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

  careersRetentionPurge: {
    task: async ({ strapi }: { strapi: Core.Strapi }) => {
      const days = retentionDays();
      if (days === 0) return;

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const stale = await strapi.db.query(JOB_APPLICATION_UID).findMany({
        where: { createdAt: { $lt: cutoff } },
        populate: { cv: true },
        limit: 500,
      });
      if (stale.length === 0) return;

      let files = 0;
      for (const application of stale) {
        // Remove the CV from the Media Library (and from GCS) first: deleting
        // only the entry would orphan the file in the bucket forever.
        const cvId = (application as any).cv?.id;
        if (cvId) {
          try {
            await strapi.plugin('upload').service('upload').remove({ id: cvId });
            files += 1;
          } catch (err: any) {
            strapi.log.warn(`[careers] could not delete CV ${cvId}: ${err?.message}`);
          }
        }
        try {
          await strapi.documents(JOB_APPLICATION_UID as any).delete({
            documentId: (application as any).documentId,
          });
        } catch (err: any) {
          strapi.log.warn(
            `[careers] could not delete application ${(application as any).id}: ${err?.message}`,
          );
        }
      }
      strapi.log.info(
        `[careers] retention purge: removed ${stale.length} application(s) older than ${days} days (${files} CV file(s))`,
      );
    },
    options: {
      rule: '30 3 * * *',
      tz: 'America/Bogota',
    },
  },
};

export default crons;
