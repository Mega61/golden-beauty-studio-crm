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
 * Notes say who paid and for what — "Monica Jaramillo · Tradicional pies · Venta 1129 ·
 * transferencia" — from the client/service the sales report put on each payment. A
 * payment whose names arrive after it was synced is relabelled on a later run (see
 * refreshNotes); only notes still exactly as this job first wrote them are touched, so
 * anything typed by hand in Actual is left alone.
 *
 * Courtesy sales — the owner's family, who are booked in AgendaPro only so the nail tech's
 * commission counts — never reach Actual: no money came in. Their clients are listed in
 * COURTESY_CLIENTS (";"-separated, matched ignoring case/accents/spacing). Each one is
 * marked synced with actual_txn_id "courtesy", so it doesn't come back and Strapi shows
 * it was left out on purpose. The name comes from the sales report, which can lag the
 * payment, so while the list is set a payment with no client yet waits up to
 * UNNAMED_GRACE_DAYS (default 3) for it before being synced as a normal sale.
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
const daysBefore = (iso, days) =>
  new Date(Date.parse(iso) - days * 86_400_000).toISOString().slice(0, 10);

// How AgendaPro client names are compared: it often adds a trailing space or drops an accent.
const normName = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// The notes this job writes. Order matters to people reading them: who, what, then the ids.
const notesFor = (inc) =>
  [inc.client_name, inc.service_name, inc.sale_id ? `Venta ${inc.sale_id}` : null, inc.method]
    .filter(Boolean)
    .join(' · ');
// What the notes looked like before the names existed — the only text refreshNotes replaces.
const bareNotesFor = (inc) => notesFor({ ...inc, client_name: null, service_name: null });

async function fetchIncomes({ incomesUrl, secret, since, all = false }) {
  const url = new URL(incomesUrl);
  if (since) url.searchParams.set('since', since);
  if (all) url.searchParams.set('all', '1');
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

/**
 * Bring the notes of already-synced incomes up to date with their client/service names.
 * Looks in every account (a sale may have been moved by hand, e.g. a cash sale AgendaPro
 * mislabelled as a transfer) and only rewrites notes that are still exactly what this
 * job wrote before the names were known, so manual edits in Actual survive.
 */
async function refreshNotes(api, named, since, endDate) {
  if (named.length === 0) return;
  const byImportedId = new Map(named.map((i) => [`agendapro-tx:${i.tx_id}`, i]));
  let updated = 0;
  for (const acct of await api.getAccounts()) {
    for (const t of await api.getTransactions(acct.id, since, endDate)) {
      const inc = byImportedId.get(t.imported_id);
      if (!inc) continue;
      const want = notesFor(inc);
      if (t.notes === want || (t.notes ?? '') !== bareNotesFor(inc)) continue;
      await api.updateTransaction(t.id, { notes: want });
      updated++;
    }
  }
  console.log(`[actual-sync] notes: ${updated} income(s) relabelled with client/service`);
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
  cfg.courtesyClients = new Set(
    env('COURTESY_CLIENTS', false, '').split(';').map(normName).filter(Boolean),
  );
  cfg.unnamedGraceDays = Number(env('UNNAMED_GRACE_DAYS', false, '3'));

  // Derive the incomes + mark-synced routes from INGEST_URL unless overridden.
  const incomesUrl = env(
    'INGEST_INCOMES_URL',
    false,
    cfg.ingestUrl.replace(/agendapro-(report|transactions)\b.*$/, 'agendapro-incomes'),
  );
  const markUrl = env('INGEST_MARK_SYNCED_URL', false, `${incomesUrl}/mark-synced`);

  console.log(`[actual-sync] start ${new Date().toISOString()} | since=${cfg.since} | dryRun=${DRY_RUN}`);

  const unsynced = await fetchIncomes({ incomesUrl, secret: cfg.ingestSecret, since: cfg.since });
  console.log(`[actual-sync] ${unsynced.length} unsynced income(s) since ${cfg.since}`);

  // Split off the courtesy sales, and hold back the ones that can't be told apart yet.
  const isCourtesy = (inc) => cfg.courtesyClients.has(normName(inc.client_name));
  const nameDue = daysBefore(bogotaToday(), cfg.unnamedGraceDays);
  const waitsForName = (inc) =>
    cfg.courtesyClients.size > 0 && !inc.client_name && inc.paid_at > nameDue;
  const courtesy = unsynced.filter(isCourtesy);
  const held = unsynced.filter((i) => !isCourtesy(i) && waitsForName(i));
  const incomes = unsynced.filter((i) => !isCourtesy(i) && !waitsForName(i));
  for (const inc of courtesy) {
    console.log(
      `[actual-sync] courtesy, not written: tx ${inc.tx_id} ${inc.paid_at} ` +
        `${fmtCOP(Number(inc.amount) * 100)} (${notesFor(inc)})`,
    );
  }
  if (held.length) {
    console.log(
      `[actual-sync] ${held.length} income(s) wait for their client name ` +
        `(up to ${cfg.unnamedGraceDays} days): ${held.map((i) => i.tx_id).join(', ')}`,
    );
  }
  // Every income since the cutover, synced or not: the ones whose names arrived late get
  // their Actual notes refreshed below.
  const named = (
    await fetchIncomes({ incomesUrl, secret: cfg.ingestSecret, since: cfg.since, all: true })
  ).filter((i) => i.client_name || i.service_name);

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
      notes: notesFor(inc),
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
    console.log(`\n  ${named.length} income(s) since ${cfg.since} have a client/service name to label with.`);
    console.log(`  ${courtesy.length} courtesy income(s) would be marked synced without writing.`);
    console.log('\n[actual-sync] DRY RUN — nothing written to Actual, nothing marked synced.');
    return;
  }
  // Courtesy sales are settled in Strapi alone, before (and whether or not) Actual is touched.
  if (courtesy.length) {
    const res = await markSynced({
      markUrl,
      secret: cfg.ingestSecret,
      synced: courtesy.map((i) => ({ tx_id: i.tx_id, actual_txn_id: 'courtesy' })),
    });
    console.log(`[actual-sync] marked ${res.marked} courtesy payment(s) as left out`);
  }
  if (incomes.length === 0 && named.length === 0) {
    console.log('[actual-sync] nothing to sync, done.');
    return;
  }

  const { default: api } = await import('@actual-app/api');
  const { mkdirSync } = await import('node:fs');
  // Actual's init expects dataDir to already exist (it scandirs it); create it since
  // it's gitignored and absent on a fresh CI runner.
  mkdirSync(cfg.dataDir, { recursive: true });
  await api.init({ dataDir: cfg.dataDir, serverURL: cfg.serverUrl, password: cfg.password });
  try {
    await api.downloadBudget(cfg.syncId);

    // Sanity-check the configured ids exist before writing.
    const accounts = await api.getAccounts();
    const known = new Set(accounts.map((a) => a.id));
    for (const acct of byAccount.keys()) {
      if (!known.has(acct)) {
        throw new Error(`Account id ${acct} not found in budget (have: ${[...known].join(', ')})`);
      }
    }

    // Use addTransactions (pure insert), NOT importTransactions: the latter fuzzy-matches
    // on amount+date and would silently merge an income into an unrelated manual entry
    // with the same price (common in a salon). We keep idempotency ourselves by skipping
    // any imported_id already present — guards the "import ok but mark-synced failed" re-run.
    const endDate = bogotaToday();
    for (const [acct, txns] of byAccount) {
      const existing = await api.getTransactions(acct, cfg.since, endDate);
      const seen = new Set(existing.map((t) => t.imported_id).filter(Boolean));
      const fresh = txns.filter((t) => !seen.has(t.imported_id));
      const skipped = txns.length - fresh.length;
      if (fresh.length === 0) {
        console.log(`[actual-sync] account ${acct}: nothing new (${skipped} already present)`);
        continue;
      }
      // addTransactions resolves to the string 'ok', not the new ids — count what we sent.
      await api.addTransactions(acct, fresh);
      console.log(
        `[actual-sync] account ${acct}: +${fresh.length} added` +
          (skipped ? `, ${skipped} skipped (already present)` : ''),
      );
    }

    await refreshNotes(api, named, cfg.since, endDate);
  } finally {
    await api.shutdown();
  }

  if (incomes.length === 0) {
    console.log(`[actual-sync] OK ${new Date().toISOString()}`);
    return;
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
