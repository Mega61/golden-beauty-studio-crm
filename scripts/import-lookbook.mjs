// One-off importer: pushes the landing repo's existing lookbook photos into
// Strapi (Media Library + lookbook-item entries). Uploads the ORIGINAL,
// un-watermarked files from public/lookbook/<category>/ so Strapi's upload hook
// applies the wordmark server-side (the bytes that land in GCS are watermarked).
//
// Idempotent: an item with the same caption + category is skipped, so you can
// re-run after adding more photos.
//
// Usage (PowerShell):
//   $env:STRAPI_URL="https://cms.goldenbeautystudio.com.co"
//   $env:STRAPI_API_TOKEN="<full-access API token>"
//   $env:LANDING_DIR="C:\...\Pages\golden-beauty-studio-landing"
//   node scripts/import-lookbook.mjs            # import
//   node scripts/import-lookbook.mjs --dry-run  # preview only
//
// Requires Node 20+ (global fetch / FormData / Blob).

import { promises as fs } from 'node:fs';
import path from 'node:path';

const STRAPI_URL = (process.env.STRAPI_URL || '').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || '';
const LANDING_DIR = process.env.LANDING_DIR || '';
const DRY = process.argv.includes('--dry-run');

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!STRAPI_URL) die('STRAPI_URL is required');
if (!TOKEN) die('STRAPI_API_TOKEN is required (Settings → API Tokens → Full access)');
if (!LANDING_DIR) die('LANDING_DIR is required (path to the landing repo)');

const SRC_ROOT = path.join(LANDING_DIR, 'public', 'lookbook');
const authHeaders = { Authorization: `Bearer ${TOKEN}` };

// "3d-piedreria" → "3d piedreria"; "animal-print-3d" → "Animal print 3d"
function captionFromBasename(base) {
  const s = base.replace(/-/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method || 'GET'} ${pathname} → ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function findCategory(slug) {
  const json = await api(
    `/api/lookbook-categories?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`,
  );
  return json.data?.[0] ?? null;
}

async function itemExists(caption, slug) {
  const json = await api(
    `/api/lookbook-items?filters[caption][$eq]=${encodeURIComponent(caption)}` +
      `&filters[category][slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`,
  );
  return (json.data?.length ?? 0) > 0;
}

async function uploadFile(filePath, ext) {
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append('files', new Blob([buf], { type: MIME[ext] }), path.basename(filePath));
  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: authHeaders,
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`upload ${path.basename(filePath)} → ${res.status} ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return json[0]; // [{ id, url, ... }]
}

async function createItem({ caption, order, categoryDocumentId, photoId }) {
  return api('/api/lookbook-items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: { caption, order, category: categoryDocumentId, photo: photoId },
    }),
  });
}

async function listCategoryFolders() {
  const entries = await fs.readdir(SRC_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

async function main() {
  console.log(`\nImporting lookbook → ${STRAPI_URL}${DRY ? '  (DRY RUN)' : ''}`);
  console.log(`Source: ${SRC_ROOT}\n`);

  let cats;
  try {
    cats = await listCategoryFolders();
  } catch {
    die(`No category folders under ${SRC_ROOT}`);
  }

  let created = 0;
  let skipped = 0;
  let missingCat = 0;

  for (const slug of cats) {
    const category = await findCategory(slug);
    if (!category) {
      console.warn(`! category "${slug}" not found in Strapi — skipping its photos (boot Strapi once to seed categories)`);
      missingCat++;
      continue;
    }
    const dir = path.join(SRC_ROOT, slug);
    const files = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && ALLOWED_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();

    let order = 0;
    for (const name of files) {
      const ext = path.extname(name).toLowerCase();
      const base = path.basename(name, ext);
      const caption = captionFromBasename(base);

      if (await itemExists(caption, slug)) {
        skipped++;
        continue;
      }
      if (DRY) {
        console.log(`  would import [${slug}] ${caption}`);
        created++;
        order++;
        continue;
      }
      const file = path.join(dir, name);
      const uploaded = await uploadFile(file, ext);
      await createItem({
        caption,
        order,
        categoryDocumentId: category.documentId,
        photoId: uploaded.id,
      });
      console.log(`  ✓ [${slug}] ${caption}`);
      created++;
      order++;
    }
  }

  console.log(
    `\nDone. ${created} ${DRY ? 'would be imported' : 'imported'}, ${skipped} skipped (already present)` +
      (missingCat ? `, ${missingCat} categories missing` : '') +
      '.\n',
  );
}

main().catch((err) => die(err.message));
