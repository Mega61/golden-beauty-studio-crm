'use strict';
/**
 * One-shot manual import of an AgendaPro reservations export (.xlsx) into Strapi.
 * The bridge/backfill tool (plan §1.5). Parsing + upsert + recompute all live in the
 * compiled `api::visit.ingest` service — the same path the automated intake route uses
 * — so this script just points the service at a file.
 *
 * Usage:
 *   node scripts/import-export.js [path/to/reservas.xlsx]
 *   (DB comes from env, same as the app. For a local dry-run point DATABASE_CLIENT
 *    at a throwaway sqlite file.)
 */
const path = require('path');
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const DEFAULT_XLSX = path.join(
  __dirname,
  '..',
  '.claude',
  'handoff',
  'reservas_526426_1781587640.xlsx',
);

async function main() {
  const xlsxPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_XLSX;
  console.log(`[import] ingesting ${xlsxPath}`);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  try {
    const summary = await app.service('api::visit.ingest').ingestAgendaProFile(xlsxPath);
    console.log('[import] ingest summary:', JSON.stringify(summary, null, 2));

    const recompute = await app.service('api::visit.winback').recomputeAll();
    console.log('[import] recompute:', JSON.stringify(recompute));

    // Quick acceptance read: clients with a live countdown, soonest deadline first.
    const clients = await app.documents('api::client.client').findMany({
      sort: ['next_recommended_date:asc'],
      limit: 1000,
    });
    console.log(`\n[import] ${clients.length} clients:`);
    for (const c of clients) {
      console.log(
        `  ${c.phone}  ${(c.full_name || '').padEnd(24)} ` +
          `last=${c.last_visit_date || '-'} ` +
          `anchor=${c.last_eligible_service || '-'} ` +
          `next=${c.next_recommended_date || '-'} ` +
          `status=${c.winback_status || '-'}` +
          `${c.needs_review ? '  ⚠ needs_review' : ''}`,
      );
    }
  } finally {
    await app.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[import] FAILED:', err);
    process.exit(1);
  });
