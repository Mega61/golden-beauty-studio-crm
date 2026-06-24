# Landing CMS — GCP + Cloudflare setup

This wires the Vercel landing page's **lookbook photos** to Strapi so the salon
owner can upload/classify photos with no developer. Photos are stored in Google
Cloud Storage, watermarked automatically on upload, and (optionally) served
through a Cloudflare-fronted `media.` subdomain.

```
Owner ──upload──▶ Strapi admin ──watermark (sharp)──▶ GCS bucket
                                                          │
Landing (Vercel) ──fetch /api/lookbook-items──▶ Strapi    │ public read
       └────────────────── next/image ◀────── media URL ◀─┘ (GCS or Cloudflare)
```

Do the parts in order. **Part 1–4 are the GCP/Strapi side; Part 5 is Vercel;
Part 6 is the one-time photo import; Part 7 is daily use.**

---

## 0. Prerequisites

- A GCP project (use your existing one or make a new one). Note its **Project ID**.
- `gcloud` CLI installed and logged in (`gcloud auth login`), or use the Cloud
  Console UI — both paths are given below.
- Access to the Portainer stack that runs Strapi, and to the Cloudflare zone for
  `goldenbeautystudio.com.co`.

Pick the **Project ID** once and reuse it:

```bash
gcloud config set project YOUR_PROJECT_ID
```

---

## 1. Create the storage bucket

You have two delivery options. **Start with Option A** (works in minutes); move
to Option B later if you want the branded `media.` domain.

### Option A — raw GCS URL (fastest, recommended to start)

Bucket name is arbitrary. Region `us-central1` is cheap; pick one near Colombia
(`southamerica-east1` = São Paulo) if you prefer lower latency.

```bash
gcloud storage buckets create gs://gbs-cms-media \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --public-access-prevention=inherited
```

Make objects publicly readable (uniform access → grant at the bucket level):

```bash
gcloud storage buckets add-iam-policy-binding gs://gbs-cms-media \
  --member=allUsers --role=roles/storage.objectViewer
```

Media will be served from `https://storage.googleapis.com/gbs-cms-media/...`.
→ `GCS_BUCKET_NAME=gbs-cms-media`, leave `GCS_BASE_URL` unset (it defaults to the
raw GCS URL). `storage.googleapis.com` is already allowed by the landing's
`next.config.ts`, so nothing else to do for images.

### Option B — branded domain via Cloudflare

GCS routes the legacy CNAME endpoint by Host header, so **the bucket name must
equal the domain**, and you must verify domain ownership first.

1. Verify ownership of `goldenbeautystudio.com.co` in
   [Google Search Console](https://search.google.com/search-console) (DNS TXT
   method — add the TXT record in Cloudflare). One-time.
2. Create the domain-named bucket:
   ```bash
   gcloud storage buckets create gs://media.goldenbeautystudio.com.co \
     --location=us-central1 --uniform-bucket-level-access
   gcloud storage buckets add-iam-policy-binding gs://media.goldenbeautystudio.com.co \
     --member=allUsers --role=roles/storage.objectViewer
   ```
3. Cloudflare → DNS → add record:
   - Type **CNAME**, Name `media`, Target `c.storage.googleapis.com`, Proxy
     **ON** (orange cloud).
4. Cloudflare → SSL/TLS → set encryption mode to **Full** (not *Full (strict)* —
   the origin presents Google's `*.storage.googleapis.com` cert, which strict
   mode would reject on hostname mismatch).
5. → `GCS_BUCKET_NAME=media.goldenbeautystudio.com.co`,
   `GCS_BASE_URL=https://media.goldenbeautystudio.com.co`, and set
   `NEXT_PUBLIC_MEDIA_HOST=media.goldenbeautystudio.com.co` on Vercel (Part 5).

> Caching: with the proxy ON, Cloudflare caches the public objects at the edge.
> Strapi sets `Cache-Control: public, max-age=86400` (tunable via
> `GCS_CACHE_MAX_AGE`).

---

## 2. Create credentials for Strapi

Strapi needs write access to the bucket. Two ways — **the dedicated key (2A) is
recommended** because it's scoped to just the Strapi container.

### 2A — dedicated service-account key (recommended)

```bash
# Create a service account
gcloud iam service-accounts create strapi-uploader \
  --display-name="Strapi media uploader"

# Grant write access to the bucket only (replace BUCKET with your bucket name)
gcloud storage buckets add-iam-policy-binding gs://BUCKET \
  --member="serviceAccount:strapi-uploader@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role=roles/storage.objectAdmin

# Create a JSON key
gcloud iam service-accounts keys create strapi-gcs-key.json \
  --iam-account=strapi-uploader@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

Open `strapi-gcs-key.json` and **flatten it to a single line**, then set it as
the `GCS_SERVICE_ACCOUNT` env var in Portainer (Part 3). On Windows PowerShell:

```powershell
(Get-Content strapi-gcs-key.json -Raw) -replace "`r`n","" -replace "`n",""
```

Copy the output. **Delete `strapi-gcs-key.json` afterwards — never commit it.**

### 2B — VM Application Default Credentials (no key file)

If Strapi runs on a GCP Compute Engine VM and you're OK granting the VM's
service account bucket access. Granting a service account is **not** blocked by
the `iam.allowedPolicyMemberDomains` org policy (that only blocks external
members like `allUsers`), so this step succeeds even on locked-down orgs.

**a. Find the VM's service account email:**

```bash
gcloud compute instances list                       # find VM_NAME + ZONE
gcloud compute instances describe VM_NAME --zone=ZONE \
  --format="value(serviceAccounts.email)"
```

The default Compute Engine SA looks like
`PROJECT_NUMBER-compute@developer.gserviceaccount.com`.

**b. Check the VM's OAuth scopes** — ADC needs both IAM roles *and* a storage
write scope. VMs created with default scopes often get only `storage-ro`, which
silently breaks uploads:

```bash
gcloud compute instances describe VM_NAME --zone=ZONE \
  --format="value(serviceAccounts.scopes)"
```

You want `…/auth/cloud-platform` or `…/auth/devstorage.read_write`. If it's
read-only, widen it (requires a stop/start):

```bash
gcloud compute instances stop VM_NAME --zone=ZONE
gcloud compute instances set-service-account VM_NAME --zone=ZONE \
  --scopes=cloud-platform
gcloud compute instances start VM_NAME --zone=ZONE
```

**c. Grant the SA write access to the bucket:**

```bash
gcloud storage buckets add-iam-policy-binding gs://BUCKET \
  --member="serviceAccount:THE_VMS_SERVICE_ACCOUNT_EMAIL" \
  --role=roles/storage.objectAdmin
```

Then **leave `GCS_SERVICE_ACCOUNT` unset** — the provider falls back to ADC via
the VM metadata server (reachable from the Docker container automatically).
(Note: this grants every container on the VM the same access.)

> This covers Strapi *writing* to the bucket. Public *read* of the media
> (`allUsers`) is a separate binding — see the org-policy note in Part 1 if your
> org blocks it.

---

## 3. Configure & redeploy Strapi (Portainer)

In the Strapi stack's environment (Portainer → your stack → Editor / env vars),
add:

| Variable | Value |
|---|---|
| `GCS_BUCKET_NAME` | your bucket name |
| `GCS_BASE_URL` | (Option B only) `https://media.goldenbeautystudio.com.co` |
| `GCS_SERVICE_ACCOUNT` | (2A only) the one-line JSON key |
| `CORS_ORIGINS` | `https://goldenbeautystudio.com.co,https://www.goldenbeautystudio.com.co` |
| `MEDIA_CSP_ORIGINS` | your media host(s), e.g. `https://media.goldenbeautystudio.com.co,https://storage.googleapis.com` |
| `WATERMARK_EXCLUDE_FOLDERS` | `Hero,Estudio` — keeps the hero + studio photos unmarked (lookbook still watermarked). See Part 8. |
| `WATERMARK_FOLDER` | leave **unset** (inverse mode; only needed to watermark ONE folder) |

Pull the new image / redeploy the stack. On boot, the logs should show:

```
[upload-watermark] active (scope: all images)
[cms] created locale es        (first boot only)
[cms] default locale set to es
[cms] seeded 6 lookbook categories
[cms] granted Public api::lookbook-item.lookbook-item.find
...
```

If `GCS_BUCKET_NAME` is set but the bucket can't be reached, Strapi will fail to
boot with a clear "Check if bucket exist" error — fix the name/credentials.

---

## 4. Verify in the admin

1. Open `https://cms.goldenbeautystudio.com.co/admin`.
2. **Content Manager → Lookbook Category** — you should see the 6 seeded
   categories (Acrílico, Polygel, Builder gel, Dipping, Semi, Press On).
3. **Settings → Internationalization** — `es` (default) and `en` exist.
4. **Settings → Users & Permissions → Roles → Public** — `Lookbook-item` and
   `Lookbook-category` have `find` + `findOne` checked (auto-granted on boot).
5. Quick upload test: create a **Lookbook Item**, attach a photo, pick a
   category, save. Open the photo in the Media Library — the gold wordmark
   should be baked into the bottom-right corner, and its URL should be on your
   bucket/domain.

---

## 5. Point the landing at Strapi (Vercel)

In the Vercel project for the landing, add environment variables (Production +
Preview):

| Variable | Value |
|---|---|
| `STRAPI_URL` | `https://cms.goldenbeautystudio.com.co` |
| `NEXT_PUBLIC_MEDIA_HOST` | (Option B only) `media.goldenbeautystudio.com.co` |

Redeploy. The lookbook section now reads from Strapi. **If `STRAPI_URL` is unset
or Strapi is unreachable, the landing automatically falls back to the bundled
photo manifest** — it never shows a blank section.

---

## 6. Import the existing photos (one-time)

Bulk-load the 26 photos already in the landing repo into Strapi. The script
uploads the **original** files (from `public/lookbook/`), so they get
watermarked by Strapi on the way in.

1. In the admin: **Settings → API Tokens → Create new token** → name it
   `import`, type **Full access**, duration as you like. Copy the token.
2. From the **CRM repo** root:

```powershell
$env:STRAPI_URL="https://cms.goldenbeautystudio.com.co"
$env:STRAPI_API_TOKEN="<the full-access token>"
$env:LANDING_DIR="C:\Users\Juanes\Documents\Code Projects\Golden Beauty Studio\Pages\golden-beauty-studio-landing"

node scripts/import-lookbook.mjs --dry-run   # preview
node scripts/import-lookbook.mjs             # import for real
```

It's idempotent (skips items already present), so re-run it any time you add new
originals to the landing repo. **Revoke the API token when done.**

---

## 7. Daily use (for the owner)

To add a nail photo to the website:

1. Go to `cms.goldenbeautystudio.com.co/admin` → **Content Manager → Lookbook
   Item → Create new entry**.
2. Upload the photo, type a short caption, choose the technique (Category), Save.
3. It appears on the site within ~1 minute (the landing revalidates every 60s).

To remove a photo: delete its Lookbook Item entry. To reorder: set the `order`
number (lower = earlier).

---

## 8. Hero image & studio photos (no watermark)

The landing's **hero background** and the **"05 — El estudio" gallery** are also
CMS-driven now. Unlike the lookbook, these should **not** carry the gold
wordmark — so they live in their own Media Library folders that the watermarker
skips (via `WATERMARK_EXCLUDE_FOLDERS=Hero,Estudio` from Part 3).

One-time setup in the admin:

1. **Media Library → Add new folder** → create `Hero` and `Estudio` (exact
   names, matching `WATERMARK_EXCLUDE_FOLDERS`). Upload into these folders so the
   images stay unmarked. (Anything uploaded outside them gets watermarked, which
   is what you want for lookbook photos.)
2. **Content Manager → Hero (landing) → edit** → set the **image** (pick the one
   you put in the `Hero` folder, or upload — but if you upload inline it lands in
   the root and *will* be watermarked, so prefer choosing from the `Hero`
   folder). Save.
3. **Content Manager → Studio Photo → Create new entry** → choose a photo from
   the `Estudio` folder, optionally type `alt` text, set `order` (lower = first;
   the first one renders large). Repeat for each studio photo. Save.

The landing reads these within ~1 minute. **If the Hero single type has no
image, or there are zero Studio Photos, the landing falls back to the bundled
`/hero.jpg` and `/space-0x.jpg`** — so the page never breaks. Studio `alt` text
falls back to the site translations by position when left blank.

> Tip: to swap the hero later, the owner just edits the Hero entry's image. To
> reorder the studio gallery, change the `order` numbers.

---

## 9. Price list (Servicios)

The landing's **"Servicios" price menu** is fully CMS-driven — names, descriptions,
prices, durations and ordering, all owner-editable, in both languages. No media,
so nothing to do on GCS/Cloudflare; it just needs Strapi reachable (Part 5's
`STRAPI_URL`). On first boot the entire current menu is **seeded automatically**
(6 categories, 30 services) — the boot log shows `[cms] seeded pricing: 6
categories, 30 items`. The seed is idempotent and keyed by slug, so any edit the
owner makes survives every reboot.

Two content types:
- **Price Category** — `label_es`/`label_en`, `sub_es`/`sub_en`, `order`.
- **Price Item** — `name_es`/`name_en`, `desc_es`/`desc_en`, `priceCOP` (number
  in pesos, no symbol), `durationMin` (minutes; leave blank for "—"), `fromPrice`
  (shows the "desde/from" prefix), `order`, and its parent **Category**.

Daily use for the owner:
1. **Content Manager → Price Item** → edit a service to change its price/name, or
   **Create new entry** to add one (fill both languages, set `priceCOP`, pick the
   Category, set `order`). To remove a service, delete its entry.
2. **Content Manager → Price Category** → rename a group or change its `order`.
3. Changes show on the site within ~1 minute.

> Prices are entered as plain numbers (e.g. `120000`); the landing formats them
> per-language (`$120.000` in es, `$120,000 COP` in en). **If Strapi is
> unreachable, the landing falls back to the prices bundled in its own repo**, so
> the menu never disappears. (The SEO/structured-data starting-price uses that
> same bundled baseline, so it can lag a CMS price change until the next deploy —
> harmless.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Strapi won't boot, "Check if bucket exist" | Wrong `GCS_BUCKET_NAME`, or the SA/VM lacks access to it. |
| Photos upload but aren't watermarked | Check boot log for `[upload-watermark] active`. If `WATERMARK_FOLDER` is set, the photo must be in that Media Library folder. SVG missing → log warns and serves unmarked. |
| Hero/studio photos came out watermarked | They were uploaded outside the `Hero`/`Estudio` folders (or those names don't match `WATERMARK_EXCLUDE_FOLDERS`). Re-upload into the right folder and re-select. |
| Admin shows broken media thumbnails | Add your media host to `MEDIA_CSP_ORIGINS` and redeploy. |
| Landing lookbook is empty / still old photos | `STRAPI_URL` not set on Vercel, or Public role missing `find`. The landing falls back to the bundled manifest when it can't reach Strapi. |
| `next/image` 400 "hostname not configured" | Set `NEXT_PUBLIC_MEDIA_HOST` to the media domain and redeploy the landing (raw `storage.googleapis.com` is already allowed). |
| Photos load but slowly | Option B + Cloudflare proxy ON gives edge caching; otherwise rely on the GCS `Cache-Control` (`GCS_CACHE_MAX_AGE`). |

---

## What this set up (for future phases)

The same plumbing (i18n locales, GCS upload, public read, watermark) is reused
by the later phases in the migration plan:

- **Phase 2 — Promotions** (`promo-scenario`): the landing already has a
  ready-to-paste Strapi resolver in `src/data/promos.ts`. Add the content type +
  `PUBLIC_READ_UIDS` entry in `src/cms/bootstrap.ts`.
- ✅ **Phase 3 — Pricing** (`price-category` / `price-item`): done — full owner
  control of bilingual names + numbers (see Part 9).
- **Phase 4 — Bio** (`link-bio` single type): resolver ready in
  `src/data/bio.ts`.
