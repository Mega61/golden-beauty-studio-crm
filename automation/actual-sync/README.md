# actual-sync

Pushes AgendaPro income into the **Actual Budget** "Golden Beauty Studio" file.

## Where the money comes from

The daily `agendapro-pull` job downloads AgendaPro's **transactions report** (the money
ledger) and POSTs it to Strapi, which upserts one `Payment` row per transaction (keyed by
`tx_id`). This job then:

1. `GET /api/ingest/agendapro-incomes?since=<cutover>` — payments not yet synced;
2. maps each to an Actual **inflow** transaction;
3. `addTransactions` into Actual (skipping `imported_id`s already there);
4. relabels already-synced incomes whose client/service arrived later
   (`?all=1`; only notes still in the bare `Venta N · <method>` form are touched);
5. `POST /api/ingest/agendapro-incomes/mark-synced` — flags them synced.

The client and service come from AgendaPro's **sales report**, which the pull job
ingests after the transactions report (`POST /api/ingest/agendapro-sales`, joined on
`sale_id`).

```
transactions.xlsx → Strapi Payment rows → [this job] → Actual Budget
```

## Mapping

| Actual field  | Source                                   |
| ------------- | ---------------------------------------- |
| `account`     | `Método de Pago` → account (see routing) |
| `amount`      | `(Monto + Propina) × 100`, positive      |
| `date`        | `Fecha` (payment date, cash basis)       |
| `imported_id` | `agendapro-tx:<tx_id>` (dedup key)       |
| `category`    | `ACTUAL_CATEGORY_SERVICIOS` (Ingresos → Servicios) |
| `payee`       | `AgendaPro`                              |
| `notes`       | `<Cliente> · <Nombre item> · Venta <ID Venta> · <method>` (names omitted until the sales report has them) |

**Account routing:** `efectivo → ACTUAL_ACCT_EFECTIVO`, `transferencia →
ACTUAL_ACCT_BANCOLOMBIA`, anything else (`otro`) → `ACTUAL_ACCT_DEFAULT` (falls back to the
Bancolombia account) with a warning. The transactions report has no cash-vs-transfer
column *other than* `Método de Pago`, so this is the only routing signal.

## Idempotency & the cutover guard

- **`imported_id`** makes Actual dedup on re-run — the job is safe to run repeatedly.
- **`ACTUAL_SYNC_SINCE`** (default: today, Bogota) skips payments dated before the cutover,
  so the automation never double-counts income you had already entered by hand. Set it once
  to the day you switch automation on, then leave it.

## Courtesy sales

The owner's family get their nails done for free. The sale is still registered in
AgendaPro — that is what the nail tech's commission is computed from — but no money comes
in, so it must not become income in Actual. Clients whose phone is in `COURTESY_PHONES`
are never written. The sales report has no phone, so Strapi looks it up from the client's
name in the CRM (`client_phone` on each income; a name two clients share gets none). Their
payments are marked synced with `actual_txn_id = "courtesy"`, which is how Strapi tells
them apart from real syncs. If the list is set but Strapi doesn't send `client_phone` yet
(not redeployed), the job fails instead of writing those sales as income. Because they never reach Actual, they also never show up in the finanzas bot's
list of sales a transfer can be linked to.

The client name arrives with the sales report, after the transactions report. While the
list is set, a payment with no name yet is held for up to `UNNAMED_GRACE_DAYS` so a
courtesy sale isn't written before it can be recognised; after that it syncs as a normal
sale (so a broken sales report delays income, but never loses it).

The job never deletes from Actual: courtesy sales written before the list existed are
cleaned up by hand.

## Run

```bash
npm install

# Preview — fetches incomes from Strapi and prints the mapped transactions.
# Needs only INGEST_URL + INGEST_SHARED_SECRET (no Actual creds).
npm run dry-run

# Live — writes to Actual and marks payments synced.
npm run sync
```

## Config (GitHub Secrets / Variables)

| Var                        | Kind   | Notes                                                        |
| -------------------------- | ------ | ------------------------------------------------------------ |
| `ACTUAL_SERVER_URL`        | secret | Your self-hosted Actual server URL                           |
| `ACTUAL_PASSWORD`          | secret | Actual server password                                       |
| `ACTUAL_SYNC_ID`           | secret | Budget Sync ID (= `groupId` in the file's `metadata.json`; Settings → Advanced → Sync ID). Budget is not E2E-encrypted, so no encryption password. |
| `ACTUAL_ACCT_BANCOLOMBIA`  | var    | Account id for transfers                                     |
| `ACTUAL_ACCT_EFECTIVO`     | var    | Account id for cash                                          |
| `ACTUAL_ACCT_DEFAULT`      | var    | Optional; account for unknown methods (default: Bancolombia) |
| `ACTUAL_CATEGORY_SERVICIOS`| var    | Income category id (Ingresos → Servicios)                    |
| `ACTUAL_SYNC_SINCE`        | var    | Optional cutover `YYYY-MM-DD` (default: today)               |
| `COURTESY_PHONES`          | var    | Optional; `;`-separated phones of clients whose sales are never paid (family). See below |
| `UNNAMED_GRACE_DAYS`       | var    | Optional; days a payment with no client name yet waits for it while `COURTESY_PHONES` is set (default 3) |
| `INGEST_URL`               | var    | Reused from agendapro-pull; incomes/mark-synced routes derived from it |
| `INGEST_SHARED_SECRET`     | secret | Reused from agendapro-pull                                   |

Current Golden Beauty Studio ids (from the exported budget file):

- Sync ID: `c2433b2c-922c-4c85-8a3b-bc683adec9c6`
- Bancolombia account: `5d101b46-01e2-4795-aa46-de35e350d889`
- Efectivo account: `26f2da3d-2adc-4d98-9c9f-ca3a0de4cfe0`
- Servicios (income) category: `3c1699a5-522a-435e-86dc-93d900a14f0e`
