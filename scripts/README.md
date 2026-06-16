# Win-back operational scripts

One-shot ops scripts for the retoque / win-back feature (Part 1). Both boot the full
Strapi app, so they read the database from the **same env vars** the server uses
(`DATABASE_CLIENT`, `DATABASE_HOST`, …). Run them from the project root.

## `import-export.js` — manual AgendaPro import

Loads an AgendaPro reservations export (`.xlsx`) and upserts Clients + Visits through
the shared `api::visit.ingest` service, then recomputes every countdown.

```bash
# against the configured DB (e.g. production Postgres via env)
node scripts/import-export.js /path/to/reservas.xlsx

# defaults to the latest export under .claude/handoff/ if no path is given
node scripts/import-export.js
```

- **Idempotent**: Clients dedupe by `phone`, Visits by a synthesized `booking_id`
  (`sha1(phone+date+service)`). Re-running changes nothing.
- A phone seen under more than one name is flagged `needs_review` + `review_note`
  (dirty AgendaPro data for Mariana to split at the source) — it never blocks.
- Status mapping: `Asiste → completed`, `Reservado → upcoming`, `Cancelado → cancelled`.

Requires `xlsx` (devDependency). On a machine that ran `npm ci --omit=dev`, install it
first: `npm i -D xlsx`.

## `stampee-crosscheck.js` — fidelization cross-check

Phone-only match of Stampee customers against Strapi clients; stamps each client
`matched | sin_tarjeta` and prints the two clean-up lists.

```bash
node scripts/stampee-crosscheck.js /path/to/customers.json   # defaults to .claude/handoff/customers.json
```

- Source today is an exported `customers.json` (from Stampee's
  `GET /customers?include=cards,transactions`). To switch to the live API later, set
  `STAMPEE_API_URL` + `STAMPEE_TOKEN` and extend `loadCustomers()`.
- Internal `@goldenbeautystudio.com.co` Stampee logins are excluded automatically.

## Daily recompute

A built-in Strapi cron (`config/cron.ts`) runs `api::visit.winback.recomputeAll` daily
at 06:00 `America/Bogota`, so the countdown rolls over without re-importing. It can be
disabled with `CRON_ENABLED=false`.

## Automated ingestion (production — no manual step)

In production the report can't be uploaded by hand, so ingestion is split in two:

**Ingestion (built, in Strapi).** Two secret-protected intake routes feed the *same*
upsert + recompute path as the manual script:

- `POST /api/ingest/agendapro-report` — multipart `report=@reservas.xlsx`. Strapi
  parses + ingests + recomputes. **Primary** path (you end up with a file).
- `POST /api/ingest/agendapro` — JSON `{ "bookings": [ {normalized}, ... ] }`.

Both require the header `x-ingest-secret: $INGEST_SHARED_SECRET`. The report route
returns `{ ok, summary }`, or **422** when a non-empty report ingests zero visits
(fail-loud signal for the caller). Example:

```bash
curl -H "x-ingest-secret: $INGEST_SHARED_SECRET" \
     -F "report=@reservas.xlsx" \
     https://cms.goldenbeautystudio.com.co/api/ingest/agendapro-report
```

**Acquisition (TODO — blocked on AgendaPro recon, plan §2.0/§2.1).** A small external
job logs into AgendaPro, downloads the reservas export, and POSTs the file to the route
above. AgendaPro has **no scheduled/email delivery**, so the job authenticates each run.
Two candidate implementations, both ending in the same xlsx → same route:

- **Protected-endpoint replay (preferred):** capture the report-download request in
  DevTools, replay it over plain HTTP with the session cookies. No browser; can run as a
  GitHub Actions cron or VM cron. Needs the recon capture first.
- **Playwright (fallback):** drive the browser to log in (handles OTP/JS) and export.
  Run ephemerally (on-demand Docker / GitHub Actions / locally) — **never steady-state on
  the VM**.

Because Strapi owns parsing + normalization + upsert, the acquisition job stays a dumb
"fetch file → POST file" client and the Playwright-vs-endpoint choice can change without
touching Strapi.

## Read API

`GET /api/winback/due?within=N&status=en_ventana,por_vencer&consent=true` — authenticated
(needs an API token or permitted role). Powers the future WhatsApp job; the admin
**Retoques** dashboard reads clients directly via the Content Manager API.
