# Golden Beauty Studio — Win-back Countdown + AgendaPro Ingestion
## Claude Code Handoff

### Objective
Inside the Strapi CRM, build two things, in priority order:

1. **(Priority 1) Register the time remaining until the next recommended service** (a 15–21 day window) for every client who has completed a service.
2. **(Priority 2) Automate the AgendaPro report extraction + ingestion** so Priority 1 stays current without the manual Sunday Excel export.

Priority 1 is the value and must be **buildable and testable today** using the existing manual export as seed data. Priority 2 replaces the manual step with an automated feed. They share one upsert/recompute code path.

**Out of scope for this handoff:** WhatsApp message sending. The schema must *accommodate* it later (consent fields + a stubbed Reminder type), but do **not** implement dispatch here.

---

### Stack & hard constraints — read before writing any code
- Strapi (headless CMS/CRM) runs on a single small **GCP Compute Engine VM (~$25/mo)** alongside Postiz and Stampee. **Strapi is the source of truth for clients + visits.**
- Landing page is on Vercel (Next.js), **not yet wired to Strapi** — out of scope here.
- **Hard NOs:**
  - No **Supabase** (does not exist anywhere).
  - No **n8n** (does not exist anywhere).
  - No **AgendaPro Plan Pro / public API** (~$100/mo — ruled out). Extraction is by **authenticated scraping only**.
  - No new heavy services on the VM. The VM is RAM-constrained — **no steady-state headless browser on it** (see P2 for where Playwright may run).
  - No secrets committed to the repo.
- **First action:** detect the environment. Read `package.json` and `config/` to confirm the **Strapi major version (v4 vs v5)** — content-type APIs, cron config, and the document/entity service differ between them — and the **configured database**. Adapt to what's actually there; do not assume.
- Work on a **feature branch**, not `master`. (Repo: the `golden-beauty-studio-crm` Strapi project — verify.)

---

## Priority 1 — Register time-remaining for next recommended service

### 1.1 Content types
Create/extend these (field types adapt to the detected Strapi version).

**Client** — dedup key = `phone`
- `phone` — string, **required, unique**
- `full_name` — string
- `whatsapp_consent` — boolean, default `false`
- `whatsapp_consent_date` — datetime, nullable *(Ley 1581 de 2012)*
- `opted_out` — boolean, default `false`
- `last_visit_date` — date, nullable *(denormalized)*
- `next_recommended_date` — date, nullable *(denormalized; driven by latest completed visit)*

**Visit** — idempotency key = `booking_id`
- `booking_id` — string, **required, unique** *(stable AgendaPro id; for manual rows without one, synthesize — see 1.5)*
- `client` — relation manyToOne → Client
- `service_name` — string *(raw AgendaPro name)*
- `service_category` — enum: `montaje | retoque | forrado | sencillo | otro`
- `service_date` — date, **required**
- `status` — enum: `completed | confirmed | cancelled | no_show`
- `source` — enum: `manual_import | agendapro`
- `next_recommended_date` — date, nullable *(computed)*

**ServiceCadence** — config, seed it
- `service_category` — enum (same set), **unique**
- `min_days` — integer (e.g. `15`)
- `max_days` — integer (e.g. `21`)
- `active` — boolean, default `true`

Seed defaults (Juanes to confirm): `montaje {15,21}`, `retoque {15,21}`, `forrado {15,21}`, `sencillo` inactive, `otro` inactive.

**Reminder** — *create but leave unused (stub for the future WhatsApp workstream)*
- `client` ref, `due_date`, `sent_at` (null), `template`, `channel`. **Do not wire sending.**

### 1.2 Service-category mapping
AgendaPro returns a free-text `service_name`. Map it to `service_category` via one **centralized, deterministic** keyword matcher (single module, easily editable), e.g.:
- contains `retoque` → `retoque`
- contains `esculpida | polygel | acrílico | dual | press` → `montaje`
- contains `forrado | dipping | nivelación` → `forrado`
- contains `semi | mani | pedi` → `sencillo`
- else → `otro`

Juanes to review the keyword map against the real catalog.

### 1.3 Computation rule
For each `Visit` with `status = completed`:
- Look up `ServiceCadence` by `service_category`. If missing or inactive → `next_recommended_date = null` (no nudge for that category).
- Else `Visit.next_recommended_date = service_date + max_days` (window end = target; `min_days` is the "earliest appropriate" edge, used later for message timing).

Derived **`time_remaining_days`** for a client = `latest_completed_visit.next_recommended_date − today`. Do **not** store it as a field (it changes daily) — compute on read, and/or refresh `Client.next_recommended_date` daily.

**Client denormalization (refresh daily):**
- `last_visit_date` = max `service_date` over completed visits.
- `next_recommended_date` = the `next_recommended_date` of the client's **latest** completed visit. A newer completed visit always supersedes older ones, so there's never a stale countdown.

### 1.4 Recompute job (Strapi built-in cron)
- Use Strapi's native cron (`config/cron.js` + enable in `config/server`). One **daily** job (06:00 `America/Bogota`):
  - recompute `Visit.next_recommended_date` for visits missing it or affected by a cadence change;
  - refresh `Client.last_visit_date` and `Client.next_recommended_date`.
- Also recompute via a **Visit create/update lifecycle hook** so freshly ingested visits update immediately; the cron is the daily reconciler.
- Put the logic in **one service module** called by both the lifecycle hook and the cron — no duplication.

### 1.5 Interim seed/import (makes P1 usable TODAY, no P2 needed)
- Provide a one-shot script (e.g. `scripts/import-export.ts`) that reads the **existing AgendaPro Excel/CSV export** and upserts Client + Visit.
- Dedup: upsert Client by `phone`; upsert Visit by `booking_id`. **If the export lacks a stable booking id**, synthesize a deterministic key = `hash(phone + service_date + service_name)` so re-running the import is idempotent.
- This is the bridge until P2 lands, and it uses the **same upsert path** P2 will reuse.

### 1.6 Read surface
- A custom authenticated route `GET /winback/due?within=N` returning clients whose `next_recommended_date ≤ today + N`, ordered soonest-first, **excluding `opted_out`** (and optionally filtering to `whatsapp_consent = true`). JSON. (Strapi admin saved views are a fallback, but ship the route.)

### 1.7 Priority 1 — acceptance criteria
- Content types exist; `ServiceCadence` seeded.
- Importing the current export populates Clients + Visits with **no duplicates on re-run**.
- Every completed visit in an active category has a correct `next_recommended_date` (= `service_date + max_days`).
- Each Client's `next_recommended_date` is driven by their **latest** completed visit.
- `GET /winback/due?within=7` returns the right clients, excludes opted-out, and shifts correctly as the daily cron runs.
- **WhatsApp sending is NOT implemented.**

---

## Priority 2 — AgendaPro report automation + ingestion

### 2.0 Recon prerequisites — BLOCKING (Juanes supplies; do not guess endpoints)
Before coding the extractor, Juanes captures from **DevTools → Network**, in one logged-in session:
- **Login flow:** the POST submitting email+password; the state/response after it; the **OTP-submit** request (URL, method, headers, payload); presence of any CSRF token, JS-computed field, or captcha.
- **Bookings data request** the web app makes: method, full URL, headers (esp. auth/cookies), query params (date range, status filter), and the **response JSON shape** — specifically the fields for booking id, client phone, service name, service date, status.
- **Session behavior:** does login re-challenge with OTP every session or remember the device? Is the session **IP-bound**? (Test: replay saved cookies from a different IP.)

Code against the captured contract, not assumptions.

### 2.1 Auth strategy (decide from recon)
- **Preferred — no browser:** if login is a scriptable form POST + OTP POST with no browser-only obstacles, implement auth as **plain HTTP**: POST creds → read OTP from email → POST OTP → capture session cookies.
- **Fallback — Playwright** (only if login has JS-computed tokens / captcha / bot checks): use it to obtain the session and save `storageState`. Playwright must **not** run steady-state on the VM — run it either as an **on-demand ephemeral Docker container** (`mcr.microsoft.com/playwright`) or **locally by Juanes**, then ship the captured cookie/`storageState` (encrypted) to the runner.
- **OTP retrieval** (only if sessions re-challenge often): **Gmail API, read-only, tightly scoped** to the AgendaPro sender / one mailbox. Poll for a message received **after** the login trigger, extract the code, submit fast (codes expire ~5–10 min), treat as **single-use**. Not IMAP app-passwords, not owner full credentials.

### 2.2 Pull job (the recurring one)
- Loads stored session cookies and calls AgendaPro's **internal bookings endpoint directly via HTTP** (no browser). Request **completed** bookings for a **rolling ~35-day window** (covers the 21-day cadence + buffer + late status changes).
- Normalize each booking → `{ booking_id, phone, full_name, service_name, service_date, status }` → map `service_category`.
- POST to the Strapi intake route (2.3).
- **Schedule:** daily. **Where:** GitHub Actions cron (free, but rotating IP — fine for a lightweight cookie-replay HTTP call **only if the session isn't IP-bound**). If the recon IP-binding test shows binding, run the pull from the **VM via cron** for a stable IP. The pull is browser-free either way, so VM RAM is not a concern.

### 2.3 Strapi intake route
- Custom authenticated route `POST /ingest/agendapro`, protected by a **shared-secret header** (env). Accepts an array of normalized bookings.
- Upserts via the **same service module** as the manual import (1.5): Client by `phone`, Visit by `booking_id`; update `status` when a booking changes (e.g. `confirmed → completed`, or `→ cancelled`). Triggers recompute (lifecycle/service).
- **Idempotent:** re-POSTing the same window must not duplicate.

### 2.4 Robustness — fail loud
- The pull job **fails the run and emits a notification** on: auth failure, **0 rows when rows were expected**, schema drift (missing expected fields), or non-2xx from the intake route. This is what makes an operated scraper acceptable — Juanes gets the alert and fixes same-day.
- Pin Playwright + browser versions if used. Log a heartbeat / last-successful-run timestamp.

### 2.5 Secrets / env
- `AGENDAPRO_EMAIL`, `AGENDAPRO_PASSWORD`, `INGEST_SHARED_SECRET`, (if used) Gmail service-account creds, Strapi base URL. In GitHub Actions secrets and/or the VM env — **never committed**.

### 2.6 Priority 2 — acceptance criteria
- A scheduled job authenticates, pulls completed bookings for the rolling window, and upserts into Strapi **idempotently**.
- Re-running produces no duplicates; status changes propagate.
- `next_recommended_date` is populated for newly ingested completed visits (via the shared recompute).
- Failures (auth, zero-rows, schema drift) **fail loudly with a notification**.
- The manual Excel export is no longer needed to keep the pipeline current.

---

## Cross-cutting / non-goals
- **Non-goals:** WhatsApp sending; wiring Strapi to the Vercel landing; Stampee integration. *(Stampee is also phone-keyed — keep `Client.phone` the canonical join key so Stampee can read from Strapi later, but build no integration here.)*
- **Guardrails:** no Supabase, no n8n, no Plan Pro, no new heavy services on the VM, no steady-state browser on the VM, no secrets in the repo.
- **Reuse one upsert/recompute service module** across manual import, intake route, lifecycle hook, and cron — single source of truth for the logic.

## Suggested sequence
1. Confirm Strapi version + DB.
2. P1: content types + `ServiceCadence` seed + category mapping + recompute service + cron/lifecycle.
3. P1: manual import script → load current export → validate acceptance criteria → `/winback/due` route.
4. *(Juanes)* P2 recon capture.
5. P2: intake route (reuse upsert) → auth → pull job → schedule → fail-loud.
6. Demote manual import to a backfill tool once the automated feed is live.

## Open questions for Juanes
- Strapi major version + database?
- Per-category cadence numbers — confirm 15–21 for montaje/retoque/forrado; what about sencillo?
- Does the manual export include **phone + a stable booking id + status**?
- AgendaPro: OTP-per-login or remembered device? Session IP-bound?
- Recurring pull on **GitHub Actions or VM cron** (depends on IP-binding)?
- Notification channel for fail-loud (email / WhatsApp to you / Slack/Discord webhook)?