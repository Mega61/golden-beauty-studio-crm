# Part 1 — Win-back Countdown + Retoque Status (Implementation Plan)

> Companion to `lastVisit.md`. This plan refines Priority 1 against the **actual**
> environment + real data, adds the **owner-facing visual layer** Juanes asked for
> (15–21 day retoque window, >21 = retoque void), and adds the **Stampee
> fidelization cross-check**. WhatsApp sending stays out of scope.

---

## 0. Environment — CONFIRMED (no longer "detect")
- **Strapi v5.46.1** (`@strapi/strapi` 5.46.1). → v5 APIs: content-types as
  `src/api/<name>/content-types/<name>/schema.json`; **Document Service**
  (`strapi.documents('api::x.x')`), not the old Entity Service; cron in
  `config/cron.ts` + `flags`/enable in `config/server.ts`; lifecycles in
  `src/api/<name>/content-types/<name>/lifecycles.ts`; admin customization in
  `src/admin/app.tsx` (already used here to inject the Google SSO button).
- **Database: PostgreSQL** (`pg` 8.20.0, `config/database.ts`). Same Postgres the
  VM runs; good — we can do set-based recompute in SQL if needed.
- Strapi is the **source of truth**. Stampee is a *separate* Fastify+Postgres app
  (its own `loyalty` schema) — we **read** from it, we do not merge DBs.
- Branch: create `feat/winback-p1` off `master`.

---

## 1. Reality check — 4 corrections the real export forces

I parsed the export (`reservas_526426_1781587640.xlsx`, 31 booking rows, last 2
months) and the Stampee schema. Findings that **change the handoff**:

### 1.1 ✅ RESOLVED — `Asiste` is the completed marker
Updated export's `Estado` now contains: **`Asiste` (17), `Reservado` (5),
`Cancelado` (9)**. `Asiste` = attended/completed — the signal we were missing. Every
`Reservado` row is dated today-or-future and every `Asiste`/`Cancelado` is in the
past, so the data is internally consistent. Mapping is now a direct lookup, no
date-derivation needed:

```
status =
  Asiste     → completed   (drives last_visit_date + retoque countdown)
  Reservado  → upcoming    (shown, does NOT reset the clock)
  Cancelado  → cancelled
```

`Confirmado` (seen in an earlier export) folds into `upcoming` if it ever reappears.
The `service_date < today` check is kept only as a **sanity guard** (warn if an
`Asiste` is dated in the future, or a `Reservado` is stale-past = likely a no-show
to clean up). When P2's live feed lands, the same map applies.

### 1.2 ✅ DECIDED — phone is the canonical identity (Colombia)
**Decision (Juanes):** in Colombia the phone number *is* the real unique client key.
So `Client.phone` = **required + unique**, and the import **dedups Client by phone,
phone alone** — no composite key, no name-based identity, no placeholder denylist.

One row pair currently shares `+573103708768` (Andrea Zapata + Esperanza Blandón).
This is treated as **dirty source data Mariana will fix in AgendaPro**, not a
modelling problem. Handling: the import flags `needs_review = true` on any Client
whose phone arrives with **more than one distinct name** (and records the conflicting
names in `review_note`) so Mariana has a punch-list — but it does **not** block the
import; the two simply collapse to one Client until she splits them at the source.
Email / ID are too sparse to use (email 5/31 rows, ID 0/31) — ignored for identity.

### 1.3 No stable booking id → synthesize (as handoff anticipated)
No `booking_id` column exists. `ID pago` is a *payment* id, present only when paid.
→ `booking_id = sha1(normalized_phone + service_date_iso + service_name)`.
Deterministic ⇒ re-running the import is idempotent. Keep it **unique**.

### 1.4 "retoque" is a *cadence*, not a booking row — the win-back core
The 20 distinct service names in the export contain **no service literally named
"retoque."** That's expected and it's the whole point: a client gets a **montaje**
(or **forrado**), and the *retoque* is the follow-up due **15–21 days later**. After
day 21 the retoque is void and they pay a full montaje again — exactly Juanes's
rule. So the countdown is anchored to the latest **retoque-eligible** completed
visit (montaje/forrado), not to a "retoque" booking.

**Category map — only the certain rows drive a countdown** (Juanes left Dipping and
Press-on unconfirmed, so we build conservatively):

| Real service name (examples)                                                                               | category   | retoque-eligible?      | certainty           |
| ---------------------------------------------------------------------------------------------------------- | ---------- | ---------------------- | ------------------- |
| Esculpidas polygel, Dual system builder gel, Dual system polygel                                           | `montaje`  | ✅ yes                  | certain             |
| Forrado en acrílico, Forrado en polygel, Nivelación base rubber, Dipping                                   | `forrado`  | ✅ yes                  | certain*            |
| Semipermanente (manos/pies/sin color), Tradicional (manos/pies), Solo limpieza manos, Semi pies y limpieza | `sencillo` | ❌ no                   | certain             |
| Press on, Press on y …                                                                                     | `press_on` | ❌ no **(default off)** | **pending Mariana** |
| anything unmatched                                                                                         | `otro`     | ❌ no                   | certain             |
| literal "retoque" keyword (future-proof)                                                                   | `retoque`  | ✅ yes                  | certain             |

`*` **Dipping's montaje-vs-forrado question is moot for the countdown** — both
categories carry the same `{15,21}` cadence and are retoque-eligible, so the timer is
identical either way. We file it under `forrado`; revisit only if cadences diverge.

**Press-on** is given its **own category, eligibility OFF by default** (Juanes leans
"not eligible"). It's the single most common attended service, so this is deliberately
conservative: those clients get **no countdown** until Mariana confirms. Flipping it
on later is a **one-row `ServiceCadence` edit** (`press_on {15,21,true}`) — no code
change, because eligibility is data-driven, not hard-coded.

Keyword matcher stays one centralized, ordered, deterministic module
(`retoque` → `press on` → `forrado/dipping/nivelación` → `montaje` set → `sencillo` set → `otro`).

---

## 2. Data model (Strapi v5 content-types)

Same shape as the handoff with the corrections above baked in.

**Client** (`api::client.client`) — **identity = `phone` (canonical, §1.2)**
- `phone` string, **required, unique** *(the dedup key)*
- `full_name` string, required
- `email` string, nullable; `id_number` string, nullable *(stored, not used for identity)*
- `whatsapp_consent` bool=false; `whatsapp_consent_date` datetime null *(Ley 1581)*
- `opted_out` bool=false
- `needs_review` bool=false; `review_note` string null *(set when one phone arrived
  with >1 distinct name — Mariana's clean-up punch-list, §1.2)*
- `last_visit_date` date null *(denormalized — latest completed visit)*
- `last_eligible_service` enum null *(montaje/forrado that anchors the countdown)*
- `next_recommended_date` date null *(= last eligible completed date + max_days)*
- `winback_status` enum: `reciente | en_ventana | por_vencer | vencido | sin_cadencia`
  *(denormalized, refreshed daily — drives the colored badge; see §4)*
- `stampee_card` enum: `matched | sin_tarjeta` null *(from §6 phone-only cross-check)*

**Visit** (`api::visit.visit`) — idempotency = `booking_id`
- `booking_id` string **required, unique** (synthesized, §1.3)
- `client` relation manyToOne → Client
- `service_name` string (raw); `service_category` enum
  (`montaje|retoque|forrado|sencillo|press_on|otro`)
- `service_date` date **required**
- `status` enum: `completed | upcoming | cancelled` *(derived, §1.1 — replaces the
  handoff's completed/confirmed/cancelled/no_show until P2 gives richer signals)*
- `source` enum: `manual_import | agendapro`
- `price_list` int null; `price_real` int null  *(present in export; cheap to keep)*
- `next_recommended_date` date null *(computed; only for eligible completed)*

**ServiceCadence** (`api::service-cadence.service-cadence`) — config, seeded
- `service_category` enum **unique**; `min_days` int; `max_days` int; `active` bool=true
- Seed: `montaje {15,21,true}`, `retoque {15,21,true}`, `forrado {15,21,true}`,
  `sencillo {0,0,false}`, `press_on {15,21,false}` *(off pending Mariana — flip `active`
  to enable)*, `otro {0,0,false}`.

**Reminder** (`api::reminder.reminder`) — **stub only, do not wire sending**
- `client` ref, `due_date`, `sent_at`=null, `template`, `channel`.

---

## 3. Computation rule (the one shared service module)

`src/api/visit/services/winback.ts` — single source of truth, called by the
import script, the Visit lifecycle hook, and the daily cron.

Per **completed** Visit:
1. `cat = mapCategory(service_name)`; look up active `ServiceCadence`.
2. If none/inactive → `Visit.next_recommended_date = null` (sencillo/otro: no nudge).
3. Else `Visit.next_recommended_date = service_date + max_days` (= deadline, day 21).

Per **Client** (denormalize, daily + on write):
- `last_visit_date` = max `service_date` over completed visits.
- `last_eligible_service` / `next_recommended_date` come from the client's **latest
  completed eligible** visit (a newer montaje/forrado always supersedes ⇒ never a
  stale countdown). If the latest completed visit is `sencillo` but an older eligible
  one is still inside its window, the eligible one still anchors the retoque clock —
  decision flagged in §7.
- `winback_status` derived from `d = today − last_eligible_visit_date` (§4).

`time_remaining_days` (= `next_recommended_date − today`) is **computed on read**,
never stored (changes daily).

---

## 4. ⭐ Visual layer — what the owner actually sees (Juanes's ask)

Goal: at a glance, **how long since a client came / when we expect them back**, with
the 15–21 day retoque window and the "past 21 = charge full montaje" rule, in clear
color. Built in two complementary surfaces.

### 4.1 Status taxonomy (drives every color/label) — `d = days since last eligible visit`
| status         | condition         | color       | Spanish badge                               |
| -------------- | ----------------- | ----------- | ------------------------------------------- |
| `reciente`     | `d < 15`          | ⚪ grey/blue | "Reciente · retoque desde {15−d} días"      |
| `en_ventana`   | `15 ≤ d ≤ 18`     | 🟢 green     | "En ventana · quedan {21−d} días"           |
| `por_vencer`   | `19 ≤ d ≤ 21`     | 🟡 amber     | "Por vencer · {21−d} días para el retoque"  |
| `vencido`      | `d > 21`          | 🔴 red       | "Vencido hace {d−21} días · cobrar montaje" |
| `sin_cadencia` | no eligible visit | ◻ neutral   | "Sin cadencia (solo sencillos)"             |

(`por_vencer` is just the last 3 days of the green window split out as amber so the
owner sees urgency; thresholds are config-driven from ServiceCadence so they move if
the numbers change.)

The "expected return" is shown as a **range** day{+15}…day{+21} plus the single
deadline date `next_recommended_date`, so the owner sees both "earliest appropriate"
and "hard cutoff."

### 4.2 Surface A — **"Retoques / Win-back" admin page** (primary, the nice one)
A small custom admin plugin page (`app.addMenuLink`) — a single dashboard the owner
opens daily:
- **Three KPI cards:** En ventana (🟢 book now), Por vencer (🟡), Vencidos (🔴).
- **Color-coded table** sorted soonest-deadline-first: name · phone · last visit
  (+ "hace N días") · anchoring service · expected-return range · **status pill** ·
  **fidelización ✓/✗** (§6). Default filter excludes `opted_out`.
- Tabs/filters: *Por vencer hoy* (the action list), *Vencidos*, *Todos*.
- Data via the read route in §5; rendered with Strapi's design system
  (`@strapi/design-system` Badge/Table) so it looks native, no extra CSS framework.
- This is the screen Juanes demos to the business owner.

### 4.3 Surface B — inline badge in Content Manager (lightweight, always-present)
Inject a colored status **Badge** into the Client list & edit views via v5 injection
zones in `src/admin/app.tsx`:
```
app.injectContentManagerComponent('listView','actions', …)   // column badge
app.injectContentManagerComponent('editView','right-links', …) // panel on the record
```
The edit-view panel shows the full phrase ("Vencido hace 6 días · cobrar montaje"),
the expected-return range, and last-visit date — so even when the owner opens a
single client record (not the dashboard) the countdown is right there.

> Both surfaces read the **same denormalized `winback_status` + `next_recommended_date`**,
> so there's no logic duplicated in the UI — the service module in §3 owns the truth.

---

## 5. Recompute job + read surface
- **Daily cron** `config/cron.ts` (06:00 `America/Bogota`, enabled in
  `config/server.ts`): recompute `Visit.next_recommended_date` where missing/affected
  by a cadence change, then refresh every Client's `last_visit_date`,
  `last_eligible_service`, `next_recommended_date`, `winback_status`.
- **Visit lifecycle hook** (`afterCreate`/`afterUpdate`) calls the same service so
  freshly imported/ingested visits update immediately; cron is the daily reconciler.
- **Read route** `GET /winback/due?within=N&status=…` (authenticated, custom
  controller): clients whose `next_recommended_date ≤ today+N`, soonest-first,
  **excludes `opted_out`**, optional `whatsapp_consent=true`, optional status filter.
  Returns the computed `time_remaining_days` + `winback_status` so the dashboard (§4.2)
  is a thin consumer. Admin saved views are the fallback, but ship the route.

---

## 6. Stampee fidelization cross-check
Goal: confirm **every AgendaPro client has a digital fidelization card**, and surface
gaps — read-only, no DB merge.

> ✅ **UNBLOCKED via `customers.json`** (18 records with `name`, `email`, `mobile`,
> `status` — `cards.json` had no identity and is not used for matching).
>
> **Matching = phone only (Juanes's decision, §1.2):**
> 1. Drop internal accounts: customers with an `@goldenbeautystudio.com.co` email
>    (staff/owner Stampee logins — Mariana Garcia, Juan Daza) → 16 real clients.
> 2. Normalize phone → digits, last 10 (`+57 313 585 6856` → `3135856856`).
> 3. Match AgendaPro `phone` ↔ Stampee `mobile`. Match ⇒ `matched`; else ⇒ `sin_tarjeta`.
>    No name matching, no special-casing — dirty data is Mariana's to fix at the source.
>
> **Cross-check on current data (20 client phones vs 16 Stampee clients):**
> - **11 `matched`** (phone found on a card).
> - **9 `sin_tarjeta`** — but this splits into two *different* clean-up actions:
>   - **Genuinely no card → issue one:** Luz Dary Escobar, Luisa Vazquez, Dulce Ruiz,
>     Yolanda Paternina *(+ Mariana Garcia = the owner's own booking, ignore)*.
>   - **Has a card but Stampee is missing the mobile → add the phone in Stampee:**
>     Rodrigo García, Jimena García, Sandra Arias, María Piedrahíta. These are exactly
>     the **5 Stampee clients with a blank `mobile`** (the 5th, Esperanza Blandón, is the
>     shared-phone row). Phone-only can't see them as matched until Mariana fills the
>     number — and that's the point: the cross-check **produces her data-cleanup list**.
> - So the report ships **two actionable lists**: "clients to give a card" and "Stampee
>   cards missing a phone." Both shrink to zero as Mariana cleans the source.

- **Source (recurring version):** Stampee's Fastify API
  `GET /customers?include=cards,transactions` (owner/admin/staff JWT, owner-scoped);
  `lib/db/customers.ts` confirms the shape (`loyalty.customers` / `loyalty.issued_cards`).
  For the one-shot seed now, the exported `customers.json` is enough.
- **Join key:** normalized `mobile` ↔ Strapi `Client.phone` (last-10-digits, Colombia).
- **Output buckets → `Client.stampee_card`:**
  - `matched` — phone found on a Stampee card (the happy path).
  - `sin_tarjeta` — AgendaPro phone with **no** Stampee match ⇒ fidelization gap.
  - The script *additionally* prints (not stored on Client) the **Stampee-side list of
    cards whose `mobile` is blank** — Mariana's "add the phone" list — so a `sin_tarjeta`
    that's really a missing-number can be reconciled.
- **Delivery:** one-shot reconciliation script
  `scripts/stampee-crosscheck.ts` (reads `customers.json` now, the live API later;
  writes `stampee_card` onto Strapi Clients + prints the two clean-up lists), surfaced
  as the **fidelización ✓/✗ column** in the §4.2 dashboard.
- **Stays a cross-check** — no card issuing/writing into Stampee here (that's Stampee's
  job; phone remains the canonical join key for any future integration).

---

## 7. Import script (makes P1 usable TODAY)
`scripts/import-export.ts` (Strapi-context script):
1. Parse the xlsx (the columns are: Fecha de realización, …, Nombre, Apellido,
   E-mail, Teléfono, N.° de identificación, Servicio, Precio lista, Precio real,
   Estado, … Origen). Map: `full_name = Nombre + Apellido`, `service_date =
   Fecha de realización`, derive `status` (§1.1), `service_category` (§1.4).
2. Normalize phone (last-10-digits). Skip rows with no phone. If a phone shows up with
   >1 distinct name, set `needs_review` + `review_note` on the Client (don't block).
3. Upsert **Client** by `phone`, **Visit** by synthesized `booking_id`
   — via the **same upsert path** P2's intake route will reuse.
4. Run the recompute service (§3). Idempotent: re-running changes nothing.

---

## 8. Acceptance criteria (Part 1) — ✅ ALL MET (branch `feat/winback-p1`)
- [x] Content types exist; `ServiceCadence` seeded with the §2 values. *(boots on
      5.46.1; bootstrap seeds all 6 cadence rows idempotently.)*
- [x] Importing `reservas_526426_*.xlsx` populates Clients + Visits, **no dupes on
      re-run** (2nd run = 0 created/updated), `Reservado` → `upcoming`, the shared-phone
      rows collapse to **one** Client flagged `needs_review` + `review_note`.
- [x] Every `Asiste` visit in an **active** category (`montaje`/`forrado`) has
      `next_recommended_date = service_date + 21`; sencillo/press_on/otro have none.
- [x] Each Client's countdown driven by **latest completed eligible** visit;
      `winback_status` correct (verified: María d=18→en_ventana, Yuri d=9→reciente, …).
- [x] **Owner dashboard** renders 3 KPI cards + color-coded table matching §4.1;
      inline badge shows in the Client **edit view** (right panel). *(Verified in a real
      browser; list-view per-row column not offered by v5 injection zones — edit-view
      badge + dashboard cover it.)*
- [x] `GET /api/winback/due?within=7` returns the right clients (the 3 en_ventana),
      excludes opted-out, 403 unauthenticated; daily cron wired (06:00 Bogotá).
- [x] Stampee cross-check populates `stampee_card`; lists 9 `sin_tarjeta` + the 5
      Stampee cards missing a phone.
- [x] **WhatsApp sending NOT implemented**; Reminder type exists unused.

> **Note on the route path:** the content API is served under the `/api` prefix, so the
> route is `GET /api/winback/due` (the handoff wrote `/winback/due`).
> **Verification ran on throwaway SQLite** (`.tmp/*.db`, gitignored) since the prod
> Postgres isn't reachable from the dev machine; run the scripts against prod env to seed
> for real (see `scripts/README.md`).

---

## 9. Build sequence
1. Branch `feat/winback-p1`; scaffold the 4 content-types + ServiceCadence seed.
2. Category matcher + `winback.ts` recompute service + Visit lifecycle hook.
3. `import-export.ts` → load the real export → verify §8 import rows by hand.
4. `cron.ts` daily recompute (enable in `server.ts`) + `GET /winback/due` route.
5. Admin visual: injection-zone badge (Surface B), then the Retoques dashboard page
   (Surface A) consuming `/winback/due`.
6. `stampee-crosscheck.ts` → `stampee_card` + fidelización column.
7. Validate all acceptance criteria against the seeded data.

---

## 10. Decisions — all resolved enough to build. Nothing blocking.
1. ✅ **Identity = phone** (Juanes). Dedup Client by phone, `required + unique`. No
   name/email/ID fallback, no denylist. Dirty rows flagged `needs_review` for Mariana.
2. ✅ **Stampee cross-check** runs on `customers.json`, **phone-only** (§6). For the
   *live* recurring version, still want `STAMPEE_API_URL` + owner/admin token in env;
   the one-shot seed needs only the export file.
3. 🟡 **Shared phone `+573103708768`** — unknown to Juanes, **Mariana to verify/clean**
   in AgendaPro. Non-blocking: import collapses it to one Client + `needs_review`.
4. 🟡 **Dipping** — moot for the countdown (montaje & forrado share `{15,21}`); filed as
   `forrado`. **Press-on** — Juanes leans not-eligible → **defaulted OFF** as its own
   `press_on` category; flip the `ServiceCadence` row to enable later. Non-blocking.
5. **por_vencer** amber split at day 19 — assumed; trivial config change if wrong.
6. **sencillo / otro** stay inactive (no countdown) — assumed certain.
7. Fail-loud notification channel — P2 only, not needed now.

**Build scope locked:** content types + cadence seed, category matcher, recompute
service (Asiste-driven, montaje/forrado active), phone-keyed import of the current
export, daily cron + `/winback/due`, the visual dashboard + inline badge, and the
phone-only Stampee cross-check. Everything uncertain is a data-driven toggle, not code.
