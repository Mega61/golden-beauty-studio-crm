// One-off fix: gives every lookbook item a unique, globally spaced `order`
// (10, 20, 30, …) that preserves the sequence the landing shows today.
//
// Why: the original import numbered photos 0, 1, 2… *per category*, so six
// photos shared order 0, six shared 1, and so on, and new admin uploads default
// to 0 too. Since the landing sorts the whole lookbook by `order`, setting a
// photo to 1 put it behind every 0 instead of first. After this runs, values
// are unique: use 5 to go first, 15 to go between the 1st and 2nd, etc.
//
// Usage:
//   STRAPI_URL=https://cms.goldenbeautystudio.com.co \
//   STRAPI_API_TOKEN=<full-access API token> \
//   node scripts/renumber-lookbook.mjs            # preview only
//   node scripts/renumber-lookbook.mjs --apply    # write the new values
//
// Requires Node 20+ (global fetch).

const STRAPI_URL = (process.env.STRAPI_URL || '').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || '';
const APPLY = process.argv.includes('--apply');
const ORDER_STEP = 10;

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!STRAPI_URL) die('STRAPI_URL is required');
if (!TOKEN) die('STRAPI_API_TOKEN is required (Settings → API Tokens → Full access)');

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method || 'GET'} ${pathname} → ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  console.log(`\nRenumbering lookbook → ${STRAPI_URL}${APPLY ? '' : '  (DRY RUN — pass --apply to write)'}\n`);

  // Same sort as the landing (src/data/lookbook.ts) so the visible sequence is kept.
  const json = await api(
    '/api/lookbook-items?fields[0]=caption&fields[1]=order' +
      '&populate[category][fields][0]=slug' +
      '&sort[0]=order:asc&sort[1]=createdAt:asc&pagination[pageSize]=200',
  );
  const items = json.data ?? [];
  if (json.meta?.pagination?.total > items.length) {
    die(`found ${json.meta.pagination.total} items but only fetched ${items.length}; raise pageSize`);
  }

  let changed = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const next = (i + 1) * ORDER_STEP;
    const mark = it.order === next ? ' ' : '*';
    console.log(`${mark} ${String(it.order).padStart(4)} → ${String(next).padStart(4)}  [${it.category?.slug ?? '-'}] ${it.caption}`);
    if (it.order === next) continue;
    changed++;
    if (APPLY) {
      await api(`/api/lookbook-items/${it.documentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { order: next } }),
      });
    }
  }

  console.log(`\nDone. ${changed} of ${items.length} ${APPLY ? 'updated' : 'would change'}.\n`);
}

main().catch((err) => die(err.message));
