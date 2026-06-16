/**
 * AgendaPro intake (plan §2.3). Two secret-protected endpoints that both feed the
 * shared `api::visit.ingest` upsert path, then trigger a recompute:
 *   POST /api/ingest/agendapro-report  — multipart xlsx file (primary; the acquisition
 *                                         job just uploads the downloaded report).
 *   POST /api/ingest/agendapro         — JSON { bookings: [...] } already-normalized.
 *
 * Auth is a shared-secret header (`x-ingest-secret` == env INGEST_SHARED_SECRET), so the
 * external job needs no admin/user session. Fails loud (422) when a non-empty report
 * ingests zero visits, so the caller can alert.
 */
const SECRET_HEADER = 'x-ingest-secret';

function secretOk(ctx: any): boolean {
  const expected = process.env.INGEST_SHARED_SECRET;
  const got = ctx.request.headers[SECRET_HEADER];
  return Boolean(expected) && typeof got === 'string' && got === expected;
}

async function recompute(): Promise<void> {
  await strapi.service('api::visit.winback').recomputeAll();
}

export default {
  async agendaproReport(ctx: any) {
    if (!secretOk(ctx)) return ctx.unauthorized('Invalid ingest secret.');

    const files = (ctx.request.files ?? {}) as Record<string, any>;
    const file = files.report ?? Object.values(files)[0];
    const filepath = file?.filepath ?? file?.path;
    if (!filepath) return ctx.badRequest('Missing xlsx file (multipart field "report").');

    let summary: any;
    try {
      summary = await strapi.service('api::visit.ingest').ingestAgendaProFile(filepath);
    } catch (err: any) {
      strapi.log.error(`[ingest] report parse/ingest failed: ${err?.message}`);
      return ctx.badRequest(`Report could not be parsed: ${err?.message}`);
    }

    await recompute();

    // Fail loud: a non-empty report that produced no visits is almost certainly broken.
    if (summary.received > 0 && summary.visits_created + summary.visits_updated === 0) {
      ctx.status = 422;
      ctx.body = { ok: false, reason: 'zero_visits_ingested', summary };
      return;
    }
    ctx.body = { ok: true, summary };
  },

  async agendapro(ctx: any) {
    if (!secretOk(ctx)) return ctx.unauthorized('Invalid ingest secret.');

    const bookings = ctx.request.body?.bookings;
    if (!Array.isArray(bookings)) {
      return ctx.badRequest('Expected JSON body { bookings: [...] }.');
    }

    const summary = await strapi.service('api::visit.ingest').upsertMany(bookings);
    await recompute();
    ctx.body = { ok: true, summary };
  },
};
