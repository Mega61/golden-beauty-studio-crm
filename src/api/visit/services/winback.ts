/**
 * Win-back recompute service — the single source of truth for denormalized
 * countdown fields. Called by the Visit lifecycle (per-record) and the daily cron
 * (full reconcile). See plan §3 / §5.
 */
import type { Core } from '@strapi/strapi';
import {
  clientWinback,
  visitNextRecommended,
  isEligible,
  bogotaToday,
  type Cadence,
} from '../../../winback/compute';

const VISIT_UID = 'api::visit.visit';
const CLIENT_UID = 'api::client.client';
const CADENCE_UID = 'api::service-cadence.service-cadence';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /** Load all cadence rows into a `category → Cadence` map. */
  async getCadenceMap(): Promise<Map<string, Cadence>> {
    const rows = await strapi.documents(CADENCE_UID).findMany({ limit: 100 });
    const map = new Map<string, Cadence>();
    for (const r of rows as any[]) map.set(r.service_category, r as Cadence);
    return map;
  },

  /**
   * Refresh a single Client's denormalized fields from its completed visits:
   * `last_visit_date`, `last_eligible_service`, `next_recommended_date`, `winback_status`.
   */
  async recomputeClient(
    clientDocumentId: string,
    cadenceMap?: Map<string, Cadence>,
  ): Promise<void> {
    if (!clientDocumentId) return;
    const map = cadenceMap ?? (await this.getCadenceMap());

    const completed = (await strapi.documents(VISIT_UID).findMany({
      filters: { client: { documentId: clientDocumentId }, status: 'completed' },
      sort: ['service_date:desc', 'createdAt:desc'],
      limit: 1000,
    })) as any[];

    let last_visit_date: string | null = null;
    let last_eligible_service: string | null = null;
    let lastEligibleDate: string | null = null;

    if (completed.length) {
      last_visit_date = completed[0].service_date;
      for (const v of completed) {
        if (isEligible(map.get(v.service_category))) {
          last_eligible_service = v.service_category;
          lastEligibleDate = v.service_date;
          break;
        }
      }
    }

    const cadence = last_eligible_service ? map.get(last_eligible_service) : undefined;
    const { winback_status, next_recommended_date } = clientWinback(
      lastEligibleDate,
      cadence,
      bogotaToday(),
    );

    await strapi.documents(CLIENT_UID).update({
      documentId: clientDocumentId,
      data: { last_visit_date, last_eligible_service, next_recommended_date, winback_status } as any,
    });
  },

  /**
   * Daily reconciler: recompute every Visit's `next_recommended_date` (picks up
   * cadence edits) and then every Client's denormalized fields (picks up the date roll).
   */
  async recomputeAll(): Promise<{ visits: number; clients: number }> {
    const map = await this.getCadenceMap();

    const visits = await this.allDocuments(VISIT_UID);
    for (const v of visits as any[]) {
      const nrd = visitNextRecommended(v.status, v.service_date, map.get(v.service_category));
      if (nrd !== (v.next_recommended_date ?? null)) {
        // db.query bypasses lifecycles → no recompute recursion.
        await strapi.db.query(VISIT_UID).update({
          where: { id: v.id },
          data: { next_recommended_date: nrd },
        });
      }
    }

    const clients = await this.allDocuments(CLIENT_UID);
    for (const c of clients as any[]) {
      await this.recomputeClient(c.documentId, map);
    }

    strapi.log.info(
      `[winback] recomputeAll: ${visits.length} visits, ${clients.length} clients`,
    );
    return { visits: visits.length, clients: clients.length };
  },

  /** Page through every document of a collection type (CRM volumes are small). */
  async allDocuments(uid: any): Promise<any[]> {
    const out: any[] = [];
    const pageSize = 200;
    for (let start = 0; ; start += pageSize) {
      const batch = await strapi.documents(uid).findMany({ start, limit: pageSize });
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    return out;
  },
});
