/**
 * ServiceCadence lifecycle — a cadence is config that drives every client's countdown,
 * so editing one (e.g. activating `press_on`, or changing min/max days) must recompute
 * the denormalized fields immediately. Without this, the admin's change only takes
 * effect on the next daily cron run. recomputeAll writes Visits via db.query and
 * Clients via the document service (neither touches ServiceCadence) → no recursion.
 */
async function recompute(): Promise<void> {
  await strapi.service('api::visit.winback').recomputeAll();
}

export default {
  async afterCreate() {
    await recompute();
  },
  async afterUpdate() {
    await recompute();
  },
  async afterDelete() {
    await recompute();
  },
};
