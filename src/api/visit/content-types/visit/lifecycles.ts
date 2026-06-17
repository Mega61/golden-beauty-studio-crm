/**
 * Visit lifecycle — keeps the Visit's own `service_category` + `next_recommended_date`
 * derived, then triggers a recompute of the linked Client. Writes back to the Visit go
 * through `strapi.db.query` (bypasses lifecycles) so there's no recompute recursion.
 * The daily cron is the reconciler; this hook is for immediacy. See plan §3 / §1.4.
 */
import { mapCategory } from '../../../../winback/category';
import { visitNextRecommended, type Cadence } from '../../../../winback/compute';

const VISIT_UID = 'api::visit.visit';
const CADENCE_UID = 'api::service-cadence.service-cadence';

async function cadenceFor(category: string | null | undefined): Promise<Cadence | undefined> {
  if (!category) return undefined;
  const rows = await strapi.documents(CADENCE_UID).findMany({
    filters: { service_category: category as any },
    limit: 1,
  });
  return rows[0] as unknown as Cadence | undefined;
}

async function onVisitWrite(event: any): Promise<void> {
  const documentId = event?.result?.documentId;
  if (!documentId) return;

  const visit = (await strapi.documents(VISIT_UID).findOne({
    documentId,
    populate: { client: true },
  })) as any;
  if (!visit) return;

  // Backfill category from the raw service name if it wasn't supplied.
  let category = visit.service_category;
  if (!category && visit.service_name) category = mapCategory(visit.service_name);

  const cadence = await cadenceFor(category);
  const nrd = visitNextRecommended(visit.status, visit.service_date, cadence);

  if (nrd !== (visit.next_recommended_date ?? null) || category !== visit.service_category) {
    await strapi.db.query(VISIT_UID).update({
      where: { id: visit.id },
      data: { next_recommended_date: nrd, service_category: category },
    });
  }

  if (visit.client?.documentId) {
    await strapi.service('api::visit.winback').recomputeClient(visit.client.documentId);
  }
}

export default {
  async afterCreate(event: any) {
    await onVisitWrite(event);
  },
  async afterUpdate(event: any) {
    await onVisitWrite(event);
  },
  async afterDelete(event: any) {
    const clientDocumentId = event?.result?.client?.documentId;
    if (clientDocumentId) {
      await strapi.service('api::visit.winback').recomputeClient(clientDocumentId);
    }
  },
};
