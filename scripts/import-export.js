'use strict';
/**
 * One-shot manual import of an AgendaPro reservations export (.xlsx) into Strapi.
 * The bridge that makes Part 1 usable before the P2 automated feed (plan §1.5).
 *
 * All mapping/normalization/upsert logic lives in the compiled `api::visit.ingest`
 * service (the single shared upsert path) — this script only parses the spreadsheet
 * into raw rows keyed by the AgendaPro column headers and hands them over.
 *
 * Usage:
 *   node scripts/import-export.js [path/to/reservas.xlsx]
 *   (DB comes from env, same as the app. For a local dry-run point DATABASE_CLIENT
 *    at a throwaway sqlite file.)
 */
const path = require('path');
const XLSX = require('xlsx');
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const DEFAULT_XLSX = path.join(
  __dirname,
  '..',
  '.claude',
  'handoff',
  'reservas_526426_1781587640.xlsx',
);

function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Resolve the AgendaPro Spanish headers to our raw-row field names.
function buildHeaderMap(headers) {
  const map = {};
  for (const h of headers) {
    const n = norm(h);
    if (n.startsWith('fecha de realiz')) map[h] = 'fecha_realizacion';
    else if (n === 'nombre') map[h] = 'nombre';
    else if (n === 'apellido') map[h] = 'apellido';
    else if (n === 'e-mail' || n === 'email') map[h] = 'email';
    else if (n === 'telefono') map[h] = 'telefono';
    else if (n.includes('identificacion')) map[h] = 'identificacion';
    else if (n === 'servicio') map[h] = 'servicio';
    else if (n === 'precio lista') map[h] = 'precio_lista';
    else if (n === 'precio real') map[h] = 'precio_real';
    else if (n === 'estado') map[h] = 'estado'; // exact: NOT "estado de pago"
  }
  return map;
}

function readRows(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  if (raw.length === 0) return [];
  const headerMap = buildHeaderMap(Object.keys(raw[0]));
  return raw.map((r) => {
    const out = {};
    for (const [header, field] of Object.entries(headerMap)) out[field] = r[header];
    return out;
  });
}

async function main() {
  const xlsxPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_XLSX;
  console.log(`[import] reading ${xlsxPath}`);
  const rows = readRows(xlsxPath);
  console.log(`[import] parsed ${rows.length} rows`);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  try {
    const summary = await app
      .service('api::visit.ingest')
      .ingestAgendaProRows(rows);
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
