# AgendaPro → Strapi daily pull

Acquisition job for Priority 2. Runs on **GitHub Actions cron** (06:00 America/Bogota),
logs into AgendaPro only when the cached session has expired, and — in one authenticated
session — pulls **two** reports: the reservations report (CRM/winback) and the
transactions report (money ledger, for finance). Strapi does all parsing/upsert.

```
load cached session
  → Playwright: open reports page
      → if logged out: email+password, then 2FA code (fetched from Gmail) → save session
  → POST .../reports/files/booking_history   { periods, booking_date:"start_time" }
      (window: WINDOW_DAYS back … WINDOW_FORWARD_DAYS forward — the forward reach
       pulls future bookings so re-bookers get marked "Agendada" in Strapi)
  → poll .../reports/files/check/{id}         until { value:true, file_uri:<S3 url> }
  → POST .../sales/transaction/export         { start_date, end_date, location_id:[] }
      (FINANCE_WINDOW_DAYS back … today, Bogota time; returns the S3 URL directly — no
       job polling. This report carries Método de Pago, unlike booking_history.)
  → download each S3 xlsx
  → POST reservations to {INGEST_URL}              (visits + recompute + Stampee)
  → POST transactions to {INGEST_TRANSACTIONS_URL} (payments; feeds the Actual sync)
```

The **Actual Budget** push runs as a separate job off the payment rows this creates — see
`automation/actual-sync`.

Captured contract this is built against: auth is an **AWS Cognito ID token** (12 h)
sent as `Authorization`; `booking_history` returns a `file_uri` job id, then `check`
returns an S3 URL when ready; `sales/transaction/export` returns `{ url }` directly.
Login uses **email 2FA**.

## One-time setup

### 1. Strapi intake (already deployed)
Set `INGEST_SHARED_SECRET` on the Strapi server (see root `.env.example`). The intake
route is `POST {STRAPI_URL}/api/ingest/agendapro-report`.

### 2. Gmail read access for the 2FA code (Workspace, domain-wide delegation)
The login email (`juan.daza@goldenbeautystudio.com.co`) receives the 2FA code; the job
reads just that, read-only.
1. In Google Cloud (a project on the `goldenbeautystudio.com.co` Workspace), create a
   **service account** and a **JSON key**. Enable the **Gmail API**.
2. In Google **Admin console → Security → API controls → Domain-wide delegation**, add
   the service account's client ID with scope
   `https://www.googleapis.com/auth/gmail.readonly`.
3. Confirm the **sender address** of AgendaPro's 2FA email (set `OTP_SENDER`; default
   `noreply@agendapro.com`).

### 3. GitHub configuration (repo → Settings)
**Secrets:**
| secret | value |
| --- | --- |
| `AGENDAPRO_EMAIL` | login email |
| `AGENDAPRO_PASSWORD` | login password |
| `GOOGLE_SA_KEY` | the service-account JSON key (whole file) |
| `GMAIL_IMPERSONATE` | the mailbox that gets the code (= login email) |
| `INGEST_SHARED_SECRET` | same value as on the Strapi server |

**Variables:**
| var | value |
| --- | --- |
| `INGEST_URL` | `https://cms.goldenbeautystudio.com.co/api/ingest/agendapro-report` |
| `INGEST_TRANSACTIONS_URL` | Optional — the transactions intake. Defaults to the sibling `…/agendapro-transactions` route derived from `INGEST_URL`. |
| `OTP_SENDER` | AgendaPro 2FA sender (e.g. `noreply@agendapro.com`) |
| `WINDOW_DAYS` | `35` (rolling window back: 21-day cadence + buffer) |
| `WINDOW_FORWARD_DAYS` | `30` (window forward: captures future/re-booked appointments so clients get marked "Agendada"). Optional — defaults to `30` when unset. |
| `FINANCE_WINDOW_DAYS` | `10` (transactions window back). Optional — defaults to `10`. Payments upsert by `tx_id`, so a short window keeps daily re-ingests cheap. |

The **actual-sync** job needs its own secrets/variables (`ACTUAL_*`) — see
`automation/actual-sync/README.md`.

## Run / test
- Manually: repo → **Actions → AgendaPro daily pull → Run workflow**.
- Locally: `npm install && npx playwright install chromium`, export the same env vars,
  then `node pull.mjs`. Point `INGEST_URL` at a local Strapi to dry-run.

## ⚠️ To verify on first run
- **Login selectors** in `lib/agendapro.mjs` use accessible labels (`Correo/Email`,
  `Contraseña/Password`, the submit button, the 2FA field). If AgendaPro's wording
  differs, adjust the locators — they're isolated in `doLogin()`.
- **2FA email format**: the parser takes the first 6-digit number in the latest email
  from `OTP_SENDER`. Confirm the code is 6 digits and the sender is right.
- **Bearer capture**: the job grabs the `Authorization` header from the app's own API
  calls; falls back to the `ap_cognito_authorization` cookie.

## Failure behaviour
Any error (login, OTP timeout, non-2xx report call, empty/zero-row report, non-2xx
intake) exits non-zero → the Actions run goes **red** and notifies. The Strapi intake
returns **422** when a non-empty report ingests zero visits. When the session finally
expires the next run just logs in again (no action needed) — only a *failed* run needs
attention.

## Security
- Never commit secrets, the session file, or downloaded reports (`.gitignore`d here).
- Gmail access is **read-only** and scoped to one mailbox via domain-wide delegation.
- Rotate `AGENDAPRO_PASSWORD` if it was ever exposed; the job reads it only from the
  GitHub secret.
