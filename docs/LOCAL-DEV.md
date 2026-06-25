# Local dev — testing the CMS integration before prod

Goal: run **both** apps on your machine and verify the whole landing-CMS
integration (lookbook, hero, studio, pricing, watermark, preview button, instant
updates) without touching production or the prod GCS bucket.

```
Strapi CRM  →  http://localhost:1337   (admin + content API + local media)
Landing     →  http://localhost:3000   (reads the CMS, falls back to bundled)
```

Two repos:
- CRM: `golden-beauty-studio-crm` (this repo)
- Landing: `…/Pages/golden-beauty-studio-landing`

---

## ⚠ Two things in your current `.env` that break local dev

Your `.env` is configured for the server, not your laptop. Before running locally:

1. **GCS is pointed at the PROD bucket.** `GCS_BUCKET_NAME=media.goldenbeautystudio.com.co`
   is set, so local uploads would try to write to the real bucket (and need GCP
   credentials you don't have locally). **Blank it for dev** → Strapi falls back
   to the local-disk provider and stores uploads in `public/uploads`.
2. **DB host is `strapiDB`.** That hostname only resolves inside Docker. Running
   `npm run develop` on the host needs either a reachable Postgres or SQLite (see
   below).

`.env` is gitignored, so editing it for local use is safe — it won't be committed.

---

## 1. CRM (Strapi) local setup

Edit `.env` — set this **local block** (comment out / blank the prod values):

```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=1337

# --- Media: use local disk, NOT the prod bucket ---
GCS_BUCKET_NAME=
GCS_BASE_URL=

# --- Visual feedback against the local landing ---
LANDING_URL=http://localhost:3000
REVALIDATE_URL=http://localhost:3000/api/revalidate
REVALIDATE_SECRET=dev-secret-change-me

# Keep your existing APP_KEYS / *_SALT / *_SECRET / ENCRYPTION_KEY lines as-is.
```

Then pick a database:

### Option A — Postgres (matches prod, recommended)

If you already have your `strapiDB` Postgres container, start it. Otherwise:

```bash
docker run --name strapiDB -e POSTGRES_USER=strapi -e POSTGRES_PASSWORD=strapi \
  -e POSTGRES_DB=strapi -p 5432:5432 -d postgres:16
```

In `.env` set the host to localhost (Strapi runs on the host, not in Docker):

```dotenv
DATABASE_CLIENT=postgres
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=strapi
DATABASE_USERNAME=strapi
DATABASE_PASSWORD=strapi
```

### Option B — SQLite (zero infra, fastest)

The repo ships only the `pg` driver, so install the SQLite driver **without
saving** it to package.json (prod must stay Postgres-only):

```bash
npm install better-sqlite3 --no-save
```

```dotenv
DATABASE_CLIENT=sqlite
DATABASE_FILENAME=.tmp/data.db
```

> Note: SQLite is great for quick checks but isn't byte-identical to prod
> Postgres. For a final pre-push pass, use Option A.

### Run it

```bash
npm install            # first time
npm run develop
```

First boot:
- Create your admin user at `http://localhost:1337/admin` (the signup screen).
  (SSO won't work locally — no Google creds — so use email + password.)
- Watch the logs for the integration wiring:
  ```
  [upload-watermark] active (scope: all images)
  [cms] created locale es / default locale set to es
  [cms] granted Public api::price-item.price-item.find  (…and the others)
  [cms] seeded 6 lookbook categories
  [cms] seeded pricing: 6 categories, 30 items
  [cms] revalidation active        (because REVALIDATE_URL is set)
  ```

---

## 2. Landing (Next.js) local setup

In the landing repo, create `.env.local`:

```dotenv
STRAPI_URL=http://localhost:1337
REVALIDATE_SECRET=dev-secret-change-me      # must match the CRM value
# NEXT_PUBLIC_MEDIA_HOST — leave unset; localhost:1337 is already allowed.
```

Run:

```bash
npm install            # first time
npm run dev            # predev runs check-pricing etc., then next dev on :3000
```

`next/image` already allows `localhost:1337`, so CMS-served photos render. If
`STRAPI_URL` is unreachable the landing silently falls back to its bundled
assets — so an empty section means "couldn't reach Strapi," not a crash.

---

## 3. How the pieces talk locally

| Concern                | Local behavior                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| CORS                   | `config/middlewares.ts` already allows `http://localhost:3000` by default.                                |
| Media                  | Local-disk provider serves `http://localhost:1337/uploads/…`; watermarking (sharp) runs the same as prod. |
| "Ver en la web" button | Opens `LANDING_URL` (→ `http://localhost:3000#…`).                                                        |
| Instant updates        | Strapi pings `REVALIDATE_URL` on save. **But see the dev caveat below.**                                  |

> **Dev caveat — revalidation:** `next dev` doesn't cache server fetches, so the
> landing already shows changes on every refresh in dev (revalidation looks
> instant regardless). To actually exercise the on-demand revalidation path
> (the 60s ISR + webhook), build the landing like prod:
> ```bash
> npm run build && npm run start   # serves :3000 with real ISR
> ```
> Then edit content in the admin and watch the page update within ~2s, and the
> CRM log print `[cms] revalidate -> 200`.

---

## 4. Feature-by-feature test checklist

**Strapi admin (`localhost:1337/admin`)**
- [ ] Content Manager shows: Lookbook Category (6), Price Category (6), Price Item (30), Hero, Studio Photo.
- [ ] Profile → Interface language → **Español** switches the panel (locale enabled).
- [ ] Open a Price Item on a narrow window (DevTools device mode, 390px): single-column, full-width fields, Save + "Open live view" at the bottom.

**Public API (anonymous)**
```bash
curl "http://localhost:1337/api/price-categories?populate[items][sort][0]=order:asc&sort[0]=order:asc"
curl "http://localhost:1337/api/lookbook-items?populate[photo][fields][0]=url&populate[category][fields][0]=slug"
curl "http://localhost:1337/api/studio-photos?populate[photo][fields][0]=url"
curl -i "http://localhost:1337/api/hero?populate[image][fields][0]=url"   # 404 until you set a Hero image — expected
```

**Landing (`localhost:3000`)**
- [ ] **Pricing** (#servicios): shows the seeded menu from the CMS. Change a price in the admin → it updates (instant in dev; ~2s with build+start).
- [ ] **Lookbook** (#trabajo): upload a photo to a Lookbook Item → appears, watermarked.
- [ ] **Hero**: set the Hero image → hero swaps; clear it → bundled `/hero.jpg`.
- [ ] **Studio** (#estudio): add Studio Photos → gallery uses them; none → bundled `/space-0x.jpg`.

**Watermark**
- [ ] Upload any image → Media Library shows the gold wordmark baked in.
- [ ] Make folders `Hero` + `Estudio`, set `WATERMARK_EXCLUDE_FOLDERS=Hero,Estudio`, upload there → **unmarked**.

---

## 5. Gotchas (most-likely-to-trip, in order)

1. **Uploads failing / hitting prod** → `GCS_BUCKET_NAME` still set. Blank it for dev.
2. **`Cannot find module 'better-sqlite3'`** → you chose SQLite; run `npm install better-sqlite3 --no-save` (or use Postgres).
3. **DB connection refused** → `DATABASE_HOST=strapiDB` on the host; set it to `localhost` (Option A) and make sure the container is up.
4. **Revalidation "looks" untested** → that's `next dev` (no caching). Use `next build && next start` to see the real webhook effect.
5. **SSO button does nothing** → expected locally; log in with email + password.
6. **Landing won't start** → `check-pricing` failed (pricing.ts ↔ dictionary mismatch). Read the error; fix the offending id.
7. **Section is empty on the landing** → it couldn't reach `STRAPI_URL`; the fallback shows bundled data only when the fetch fails — check the CRM is up and CORS/URL are right.

---

## 6. When dev looks good → prod

Nothing here changes prod. To ship, push the branch, let CI build the image, and
in Portainer set the real values (Postgres, GCS bucket + ADC, `LANDING_URL`,
`REVALIDATE_URL`, `REVALIDATE_SECRET`) per `docs/GCP-CLOUDFLARE-SETUP.md`, and
the matching `REVALIDATE_SECRET` + `STRAPI_URL` on Vercel.


2. Run the importer (PowerShell, from the CRM repo root):
$env:STRAPI_URL="https://cms.goldenbeautystudio.com.co"
$env:STRAPI_API_TOKEN="<paste the full-access token>"
$env:LANDING_DIR="C:\Users\Juanes\Documents\Code Projects\Golden Beauty Studio\Pages\golden-beauty-studio-landing"

node scripts/import-lookbook.mjs --dry-run   # preview — uploads nothing
node scripts/import-lookbook.mjs             # the real import

3. Revoke the token when it's done (Settings → API Tokens → delete import). It's a one-off; no reason to leave a full-access token lying around.
