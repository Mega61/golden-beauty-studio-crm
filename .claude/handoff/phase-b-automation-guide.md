# Phase B — Automate the AgendaPro feed

Phase A lights up the dashboard with a manual report drop. **Phase B** makes the feed
hands-off: a GitHub Actions cron logs into AgendaPro (email + 2FA), pulls the
reservations report, and uploads it to Strapi — daily, with no manual step.

> Prerequisite: Phase A is done (branch deployed, `INGEST_SHARED_SECRET` set, dashboard
> seeding verified). Deeper detail for every step lives in
> `automation/agendapro-pull/README.md`.

---

## 5. Change your AgendaPro password
It was exposed (AgendaPro stores it in browser localStorage in plaintext, and it was
shared during recon). Change it now — you'll use the new password in step 7.

## 6. Gmail access for the 2FA code
The login emails a 6-digit code; the job reads just that, read-only.
1. In Google Cloud (a project on the **goldenbeautystudio.com.co** Workspace), create a
   **service account** and download a **JSON key** (requires enabling SA key creation —
   see the org-policy note below). Enable the **Gmail API**.
2. In Google **Admin console → Security → API controls → Domain-wide delegation**, add
   the service account's client ID with scope
   `https://www.googleapis.com/auth/gmail.readonly`.
3. Note AgendaPro's 2FA **sender address** (used as `OTP_SENDER`; default
   `noreply@agendapro.com`).

> If "create key" is blocked by `iam.disableServiceAccountKeyCreation`: in
> **IAM & Admin → Organization Policies**, pick the project, open *Disable service account
> key creation*, **Override** the parent and set enforcement **Off**, save, then create
> the key. Needs the **Organization Policy Administrator** role.

## 7. GitHub configuration (repo → Settings)

**Secrets** (Settings → Secrets and variables → Actions → *Secrets*):

| secret                 | value                                               |
| ---------------------- | --------------------------------------------------- |
| `AGENDAPRO_EMAIL`      | the login email                                     |
| `AGENDAPRO_PASSWORD`   | the **new** password from step 5                    |
| `GOOGLE_SA_KEY`        | the whole service-account JSON key                  |
| `GMAIL_IMPERSONATE`    | mailbox that receives the code (= login email)      |
| `INGEST_SHARED_SECRET` | **same value** as set on Strapi in Phase A (step 2) |

**Variables** (same screen → *Variables*):

| variable      | value                                                               |
| ------------- | ------------------------------------------------------------------- |
| `INGEST_URL`  | `https://cms.goldenbeautystudio.com.co/api/ingest/agendapro-report` |
| `OTP_SENDER`  | AgendaPro 2FA sender (e.g. `noreply@agendapro.com`)                 |
| `WINDOW_DAYS` | `35` (rolling window: 21-day cadence + buffer)                      |

## 8. Run it manually and verify
Repo → **Actions → AgendaPro daily pull → Run workflow**, then watch the log.

On this **first run**, confirm the two things that were guessed against the real page:
- the **login selectors** (email / password / submit / 2FA field), and
- that the **2FA email** is a 6-digit code from `OTP_SENDER`.

If either is off, the run fails with a clear error — send the failure log; it's a small
fix isolated in `automation/agendapro-pull/lib/agendapro.mjs` (`doLogin()`).

---

## After step 8 — it runs itself
- The puller feeds Strapi at **06:00 America/Bogotá** daily.
- The Strapi recompute cron rolls the countdowns forward each day.
- The dashboard (**Retoques**) stays current; the cached session means the browser/2FA
  only fires when the session expires (≈ weekly/monthly), not every run.
- A **failed run goes red and emails you** — that's the only time you need to look.
- The manual import / curl becomes a backfill tool, no longer needed for the daily feed.

## Notes
- **Minimum to see it working today: just Phase A.** Phase B is the hands-off layer.
- Two non-blocking business decisions, whenever you get to them:
  - **Press-on retoque eligibility** — flip the `press_on` row in Content Manager →
    Service Cadence to `active`. (The cadence lifecycle recomputes immediately.)
  - **Shared phone** `+573103708768` (Andrea Zapata / Esperanza Blandón) — confirm with
    Mariana; clients on it are flagged `needs_review`.
- **Security:** never commit secrets, the session file, or downloaded reports. Gmail
  access is read-only and scoped to one mailbox.
