/**
 * AgendaPro income -> Actual Budget sync (GitHub Actions).
 *
 * Reads the not-yet-synced Payment rows from Strapi (GET /ingest/agendapro-incomes),
 * maps each to an Actual inflow transaction, and imports them. Idempotent on both ends:
 *   - imported_id = `agendapro-tx:<tx_id>` so Actual dedups on re-run;
 *   - after import, Strapi flags those payments synced (POST .../mark-synced).
 *
 * Routing:
 *   method 'efectivo'      -> ACTUAL_ACCT_EFECTIVO
 *   method 'transferencia' -> ACTUAL_ACCT_BANCOLOMBIA
 *   method 'otro'          -> ACTUAL_ACCT_DEFAULT (defaults to the Bancolombia account)
 * All rows land in the ACTUAL_CATEGORY_SERVICIOS income category.
 *
 * Amounts are COP; Actual stores integer minor units (value * 100), positive = inflow.
 *
 * `--dry-run` (or DRY_RUN=1) fetches and prints the mapped transactions WITHOUT touching
 * Actual or marking anything synced — run it first to eyeball what would post.
 *
 * Fails loud (non-zero exit) on any error so the CI run goes red and notifies.
 */

// `@actual-app/api` is imported lazily (only for a live run) so `--dry-run` can preview
// the mapping without the heavy dependency installed.
const DRY_RUN = process.argv.includes('--dry-run') || /^(1|true)$/i.test(process.env.DRY_RUN ?? '');

function env(name, required = true, fallback = undefined) {
  const raw = process.env[name];
  const v = raw === undefined || raw === '' ? fallback : raw;
  if (required && (v === undefined || v === '')) throw new Error(`Missing env ${name}`);
  return v;
}

// Colombia is UTC-5 year-round; shift before slicing so a post-midnight-UTC run resolves
// to the correct Bogota day.
const bogotaToday = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const fmtCOP = (minor) => `$${(minor / 100).toLocaleString('es-CO')}`;

async function fetchIncomes({ incomesUrl, secret, since }) {
  const url = new URL(incomesUrl);
  if (since) url.searchParams.set('since', since);
  const res = await fetch(url, { headers: { 'x-ingest-secret': secret } });
  const text = await res.text();
  if (!res.ok) throw new Error(`incomes GET ${res.status}: ${text}`);
  const body = JSON.parse(text);
  if (!Array.isArray(body.incomes)) throw new Error(`incomes response missing "incomes" array: ${text}`);
  return body.incomes;
}

async function markSynced({ markUrl, secret, synced }) {
  const res = await fetch(markUrl, {
    method: 'POST',
    headers: { 'x-ingest-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify({ synced }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mark-synced POST ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  const cfg = {
    // Strapi intake (needed in every mode).
    ingestUrl: env('INGEST_URL'),
    ingestSecret: env('INGEST_SHARED_SECRET'),
    since: env('ACTUAL_SYNC_SINCE', false, bogotaToday()),

    // Actual connection + mapping (only strictly required for a live run).
    serverUrl: env('ACTUAL_SERVER_URL', !DRY_RUN),
    password: env('ACTUAL_PASSWORD', !DRY_RUN),
    syncId: env('ACTUAL_SYNC_ID', !DRY_RUN),
    acctBancolombia: env('ACTUAL_ACCT_BANCOLOMBIA', !DRY_RUN),
    acctEfectivo: env('ACTUAL_ACCT_EFECTIVO', !DRY_RUN),
    categoryServicios: env('ACTUAL_CATEGORY_SERVICIOS', !DRY_RUN),
    dataDir: env('ACTUAL_DATA_DIR', false, './.actual-cache'),
  };
  cfg.acctDefault = env('ACTUAL_ACCT_DEFAULT', false, cfg.acctBancolombia);

  // Derive the incomes + mark-synced routes from INGEST_URL unless overridden.
  const incomesUrl = env(
    'INGEST_INCOMES_URL',
    false,
    cfg.ingestUrl.replace(/agendapro-(report|transactions)\b.*$/, 'agendapro-incomes'),
  );
  const markUrl = env('INGEST_MARK_SYNCED_URL', false, `${incomesUrl}/mark-synced`);

  console.log(`[actual-sync] start ${new Date().toISOString()} | since=${cfg.since} | dryRun=${DRY_RUN}`);

  const incomes = await fetchIncomes({ incomesUrl, secret: cfg.ingestSecret, since: cfg.since });
  console.log(`[actual-sync] ${incomes.length} unsynced income(s) since ${cfg.since}`);
  if (incomes.length === 0) {
    console.log('[actual-sync] nothing to sync, done.');
    return;
  }

  const acctFor = (method) =>
    method === 'efectivo' ? cfg.acctEfectivo
      : method === 'transferencia' ? cfg.acctBancolombia
        : cfg.acctDefault;

  // Group mapped transactions by target account (importTransactions is per-account).
  const byAccount = new Map();
  for (const inc of incomes) {
    if (inc.method === 'otro') {
      console.warn(`[actual-sync] WARN tx ${inc.tx_id}: method 'otro' -> default account`);
    }
    const acct = acctFor(inc.method);
    const txn = {
      date: inc.paid_at,
      amount: Math.round((Number(inc.amount) + Number(inc.tip || 0)) * 100), // COP -> minor, inflow
      payee_name: 'AgendaPro',
      imported_id: `agendapro-tx:${inc.tx_id}`,
      category: cfg.categoryServicios,
      notes: [inc.sale_id ? `Venta ${inc.sale_id}` : null, inc.method].filter(Boolean).join(' · '),
      cleared: true,
    };
    if (!byAccount.has(acct)) byAccount.set(acct, []);
    byAccount.get(acct).push(txn);
  }

  const total = incomes.reduce((s, i) => s + (Number(i.amount) + Number(i.tip || 0)) * 100, 0);
  console.log(`[actual-sync] mapped ${incomes.length} txn(s), total ${fmtCOP(total)} across ${byAccount.size} account(s)`);

  if (DRY_RUN) {
    for (const [acct, txns] of byAccount) {
      const sub = txns.reduce((s, t) => s + t.amount, 0);
      console.log(`\n  account ${acct} — ${txns.length} txn(s), ${fmtCOP(sub)}`);
      for (const t of txns) {
        console.log(`    ${t.date}  ${fmtCOP(t.amount).padStart(12)}  ${t.imported_id}  (${t.notes})`);
      }
    }
    console.log('\n[actual-sync] DRY RUN — nothing written to Actual, nothing marked synced.');
    return;
  }

  const { default: api } = await import('@actual-app/api');
  const { mkdirSync } = await import('node:fs');
  // Actual's init expects dataDir to already exist (it scandirs it); create it since
  // it's gitignored and absent on a fresh CI runner.
  mkdirSync(cfg.dataDir, { recursive: true });
  await api.init({ dataDir: cfg.dataDir, serverURL: cfg.serverUrl, password: cfg.password });
  try {
    await api.downloadBudget({ syncId: cfg.syncId });

    // Sanity-check the configured ids exist before writing.
    const accounts = await api.getAccounts();
    const known = new Set(accounts.map((a) => a.id));
    for (const acct of byAccount.keys()) {
      if (!known.has(acct)) {
        throw new Error(`Account id ${acct} not found in budget (have: ${[...known].join(', ')})`);
      }
    }

    for (const [acct, txns] of byAccount) {
      const r = await api.importTransactions(acct, txns);
      console.log(
        `[actual-sync] account ${acct}: +${r.added?.length ?? 0} added, ${r.updated?.length ?? 0} updated` +
          (r.errors?.length ? `, ${r.errors.length} error(s)` : ''),
      );
      if (r.errors?.length) throw new Error(`importTransactions errors: ${JSON.stringify(r.errors)}`);
    }
  } finally {
    await api.shutdown();
  }

  // Flag every fetched payment synced. Safe even if this fails: the imported_id dedup
  // means a re-run won't create duplicates in Actual.
  const synced = incomes.map((i) => ({ tx_id: i.tx_id, actual_txn_id: null }));
  const res = await markSynced({ markUrl, secret: cfg.ingestSecret, synced });
  console.log(`[actual-sync] marked ${res.marked} payment(s) synced`);
  console.log(`[actual-sync] OK ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error('[actual-sync] FAILED:', err?.stack ?? err);
  process.exit(1);
});
