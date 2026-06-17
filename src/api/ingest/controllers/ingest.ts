/**
 * AgendaPro intake (plan §2.3). Two secret-protected endpoints that both feed the
 * shared `api::visit.ingest` upsert path, then trigger a recompute:
 *   POST /api/ingest/agendapro-report  — multipart xlsx file (primary; the acquisition
 *                                         job just uploads the downloaded report).
 *   POST /api/ingest/agendapro         — JSON { bookings: [...] } already-normalized.
 *   POST /api/ingest/stampee           — multipart customers.json; runs the fidelization
 *                                         cross-check (no committed files / shell needed).
 *
 * Auth is a shared-secret header (`x-ingest-secret` == env INGEST_SHARED_SECRET), so the
 * external job needs no admin/user session. Fails loud (422) when a non-empty report
 * ingests zero visits, so the caller can alert.
 */
import fs from 'fs';

const SECRET_HEADER = 'x-ingest-secret';

function secretOk(ctx: any): boolean {
  const expected = process.env.INGEST_SHARED_SECRET;
  const got = ctx.request.headers[SECRET_HEADER];
  return Boolean(expected) && typeof got === 'string' && got === expected;
}

async function recompute(): Promise<void> {
  await strapi.service('api::visit.winback').recomputeAll();
}

/** Best-effort Stampee sync — never throws, so a Stampee outage can't break ingest. */
async function stampeeSyncSafe(): Promise<any> {
  try {
    const autocreate = process.env.STAMPEE_AUTOCREATE === 'true';
    return await strapi.service('api::client.stampee').syncFromApi({ autocreate });
  } catch (err: any) {
    strapi.log.error(`[stampee] sync failed (non-fatal): ${err?.message}`);
    return { error: err?.message };
  }
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
    const stampee = await stampeeSyncSafe();

    // Fail loud: a non-empty report that produced no visits is almost certainly broken.
    if (summary.received > 0 && summary.visits_created + summary.visits_updated === 0) {
      ctx.status = 422;
      ctx.body = { ok: false, reason: 'zero_visits_ingested', summary, stampee };
      return;
    }
    ctx.body = { ok: true, summary, stampee };
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

  async stampee(ctx: any) {
    if (!secretOk(ctx)) return ctx.unauthorized('Invalid ingest secret.');

    // Accept a multipart customers.json (preferred) or a JSON body.
    const files = (ctx.request.files ?? {}) as Record<string, any>;
    const file = files.customers ?? Object.values(files)[0];
    let customers: any;
    try {
      if (file?.filepath ?? file?.path) {
        const raw = fs.readFileSync(file.filepath ?? file.path, 'utf8').replace(/^﻿/, '');
        customers = JSON.parse(raw);
      } else {
        customers = ctx.request.body;
      }
    } catch (err: any) {
      return ctx.badRequest(`customers.json could not be parsed: ${err?.message}`);
    }

    const list = Array.isArray(customers)
      ? customers
      : customers?.data ?? customers?.customers;
    if (!Array.isArray(list)) {
      return ctx.badRequest('Expected a customers array (multipart "customers" file or JSON array).');
    }

    const summary = await strapi.service('api::client.stampee').crosscheck(list);
    ctx.body = { ok: true, summary };
  },

  /**
   * Live Stampee sync on demand. `?dryRun=1` lists who would get a card without writing
   * (use this before enabling auto-create). Otherwise honours STAMPEE_AUTOCREATE, or
   * force it with `?autocreate=1`.
   */
  async stampeeSync(ctx: any) {
    if (!secretOk(ctx)) return ctx.unauthorized('Invalid ingest secret.');
    const q = ctx.query ?? {};
    const dryRun = q.dryRun === '1' || q.dryRun === 'true';
    const autocreate =
      !dryRun &&
      (process.env.STAMPEE_AUTOCREATE === 'true' || q.autocreate === '1' || q.autocreate === 'true');
    try {
      const result = await strapi.service('api::client.stampee').syncFromApi({ autocreate, dryRun });
      ctx.body = { ok: true, result };
    } catch (err: any) {
      strapi.log.error(`[stampee] sync failed: ${err?.message}`);
      ctx.status = 502;
      ctx.body = { ok: false, error: err?.message };
    }
  },
};
