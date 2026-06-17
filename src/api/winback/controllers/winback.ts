/**
 * Win-back read API. Thin controller over the `api::visit.winback` service so the
 * same query backs the HTTP route, the admin dashboard, and the future WhatsApp job.
 */
import { bogotaToday } from '../../../winback/compute';

export default {
  async due(ctx: any) {
    const { within, status, consent } = ctx.query ?? {};
    const data = await strapi.service('api::visit.winback').due({
      within: within !== undefined && within !== '' ? Number(within) : undefined,
      status,
      consentOnly: consent === 'true' || consent === '1',
    });
    ctx.body = {
      data,
      meta: { count: data.length, today: bogotaToday(), within: within ?? 7 },
    };
  },
};
