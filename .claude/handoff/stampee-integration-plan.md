# Stampee fidelization integration — plan

Goal: make the fidelization link **robust and automatic**. Two capabilities:

- **A) Live cross-check** — fetch cards from the Stampee API and update each
  `Client.stampee_card`, replacing the manual `customers.json` upload.
- **B) Auto-issue cards** — when the AgendaPro report is ingested, ensure every
  (attended) client has a Stampee customer + card; create the missing ones.

All of this runs **inside Strapi** (it holds the client list, the cross-check logic,
and will hold the Stampee API key). The GitHub puller stays dumb: it just uploads the
report; Strapi does ingest → recompute → Stampee sync.

---

## 1. Stampee API facts that shape the design
- **Auth = API key** (`Authorization: Bearer stmp_…`), created in the Stampee web app
  (Settings → API e integraciones). Base URL `https://api.loyalty.goldenbeautystudio.com.co`.
  Key lives as a Strapi env var — never in GitHub.
- **Read cards:** `GET /customers?include=cards` → `{ ok, data:[{...customer, cards:[…]}] }`.
  No `GET /cards` list; cards are nested under customers.
- **Create customer:** `POST /customers { name, email, mobile?, status }`. **`email` is
  required**; `mobile` is optional. Conflict → `409 EMAIL_TAKEN`.
- **Issue card:** `POST /cards { customerId, campaignId }`. Needs a **campaignId**
  (the "Golden Beauty Studio" campaign). `409` if the campaign is disabled.
- **Add stamp (future):** `PATCH /cards/:id { stamps, lastVisit }` + optional
  `POST /cards/:id/transactions`.
- Envelope: always branch on `ok`. Rate limit **300/min** (fine for ~30 clients).
- Key-driven changes are audited as `actorRole: "api"`.

---

## 2. The constraints that need a decision

### 2.1 ✅ Email is optional — create with name + mobile only
Confirmed in Stampee's schema (`email: z.string().default('')`, `mobile` optional): we
create customers with just `{ name, mobile: phone, status: "Active" }` — **no email**.
That removes the synth-email idea entirely. Use the real email only if the export has one.

### 2.2 ✅ Phone is the sole dedup key (Juanes)
Match `Client.phone` ↔ Stampee `mobile` (last-10), nothing else. The ~5 Stampee cards with
a **blank mobile** are a **manual data error** Mariana will fix (add the number) — not
something the matcher works around. When we create a customer we set `mobile = phone`, so
every card we issue is matchable on the next run.

⚠️ **Sequencing this implies:** until those blank mobiles are filled, phone-only matching
sees those clients as cardless. The **dry-run** (rollout step 2) surfaces exactly that list
*before any write*, so the fix-the-phones cleanup happens first. Only enable auto-create
once the dry-run shows no already-carded client in the "would create" list — otherwise
those few get a duplicate card.

### 2.3 Which clients get a card?
"Every client should have one," but reservations/cancellations aren't real visits.
→ **Proposed default:** auto-issue only for clients with **≥1 completed (`Asiste`) visit**.
Opt-in via a flag so it's off until you've reviewed a dry-run. (Decision needed.)

### 2.4 campaignId
Issuing needs the GBS campaign id.
→ **Proposed:** read it from env `STAMPEE_CAMPAIGN_ID`, or auto-pick the single enabled
campaign from `GET /campaigns`. (Decision needed.)

### 2.5 Failure isolation
A Stampee outage must **never** break the win-back feed. The sync is best-effort: it runs
after ingest+recompute, per-client errors are caught and logged, and it returns a summary
— it never throws out of the report ingest.

---

## 3. Architecture

**New env (Strapi):**
`STAMPEE_API_URL`, `STAMPEE_API_KEY`, `STAMPEE_CAMPAIGN_ID` (optional),
`STAMPEE_AUTOCREATE` (`true|false`, default `false`),
`STAMPEE_EMAIL_DOMAIN` (default `no-email.goldenbeautystudio.com.co`).

**Extend `api::client.stampee` service:**
- `fetchCustomers()` — `GET /customers?include=cards` live; returns the same array shape
  the existing `crosscheck(customers[])` already consumes.
- `syncFromApi()` — `fetchCustomers()` → `crosscheck()` (updates `stampee_card`) → if
  `STAMPEE_AUTOCREATE`, `ensureCards()` for the gap.
- `ensureCards(report)` — for each eligible cardless client: `POST /customers` (if no
  match) then `POST /cards`; idempotent; returns `{created_customers, issued_cards,
  skipped, errors}`.
- Keep `crosscheck(customers[])` (the offline/file path) unchanged.

**Triggers:**
- **After report ingest** — the `agendapro-report` intake controller calls
  `stampee.syncFromApi()` in a try/catch (best-effort) after recompute. ← primary.
- **Manual** — `POST /api/ingest/stampee-sync` (secret-gated) to run on demand.
- (Optional) the daily cron.

**Data model (optional but recommended):** add `Client.stampee_customer_id` and
`Client.stampee_card_unique_id` so we can link/stamp later and strengthen idempotency.

---

## 4. Auto-issue flow (idempotent, per client)
1. Build an index of Stampee customers by **phone-last10**.
2. For each Strapi client passing the gate (≥1 `Asiste` visit):
   - Match by phone. If matched **and** has a card → `matched`, done.
   - Matched customer, **no card** → `POST /cards` → `matched`.
   - **No match** → `POST /customers { name, mobile: phone, status:"Active" }` (add
     `email` only if the export has a real one) → `POST /cards`.
   - Save `stampee_card = matched` (+ ids if we add those fields).
3. Return a summary; log per-client outcomes.

---

## 5. Rollout sequence (low-risk first)
1. **Live cross-check (read-only).** `fetchCustomers()` + wire `syncFromApi()` (no
   create) into the intake controller. Retires the manual `customers.json` upload.
2. **Dry-run auto-create.** `ensureCards()` with a `dryRun` flag → logs the would-create
   list for you to review. No writes to Stampee.
3. **Enable auto-create.** Flip `STAMPEE_AUTOCREATE=true` after the dry-run looks right.
4. ✅ **Per-visit stamping (built).** `stampVisits()` adds one stamp per completed visit:
   first ever = "Primera visita", the rest = "Visita recurrente". Idempotency is via
   `Client.stampee_stamped_count` (how many visits already stamped) — only *new* visits
   stamp, so daily re-imports never double-count. Stamps stop at the campaign goal (manual
   redemption); the counter only advances by stamps actually applied, so after a redemption
   the remaining visits land on the fresh card. OFF until `STAMPEE_AUTOSTAMP=true`; dry-run
   via `POST /api/ingest/stampee-sync?dryRun=1` (reports a `stamping.would_stamp` list).
   Decisions: every completed (Asiste) visit counts; never auto-redeem.

---

## 6. Decisions
1. ✅ **Email** — not required; create with `name + mobile` only (no synth email).
2. ✅ **Who gets a card** — only clients with ≥1 attended (`Asiste`) visit.
3. **campaignId** — confirm the GBS campaign id, or let it auto-pick the enabled one. *(default: auto-pick)*
4. **Trigger** — auto after each report ingest + a manual route. *(default: yes to both)*
5. **Store `stampee_customer_id` / `card_unique_id` on Client** for traceability/future
   stamping. *(default: yes, recommended)*
6. ⛳ **PREREQ — API key + campaign id:** create a Stampee key (Settings → API e
   integraciones) for the Strapi env (`STAMPEE_API_KEY`, `STAMPEE_API_URL`) and confirm
   the campaign id (or rely on auto-pick).

> Prereq either way: a Stampee **API key** (§1) in the Strapi env, plus the
> **campaign id**. With those + the answers above I can build step 1 (read-only) first,
> then the dry-run, then flip on auto-create.
