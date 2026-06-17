/**
 * AgendaPro acquisition via Playwright. Reuses a cached session (cookies) and only
 * performs the email-2FA login when the session has expired. Once authenticated it
 * runs the report API in the browser context (cookies + captured Bearer), polls until
 * ready, and returns the S3 download URL. See plan §2.1 / §2.2 and the captured contract.
 *
 * ⚠️ SELECTORS TO VERIFY against the real login page on first run — they use
 * accessible labels/roles (robust) but AgendaPro's exact wording may differ.
 */
import { chromium } from 'playwright';

const APP = 'https://app.agendapro.com';
const REPORTS_URL = `${APP}/bookings-reports/history`;
const API = 'https://agendapro.com/api/views/admin/v2/reports/files';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) => d.toISOString().slice(0, 10);

function needsLogin(url) {
  return /sign_in|two_factor|login/i.test(url);
}

async function doLogin(page, { email, password, getOtp }) {
  // --- credentials step ---
  await page.getByLabel(/correo|e-?mail/i).first().fill(email);
  await page.getByLabel(/contrase|password/i).first().fill(password);
  const sinceEpochMs = Date.now();
  await page.getByRole('button', { name: /iniciar|ingresar|sign in|log ?in|continuar/i }).first().click();

  // --- 2FA step (email code) ---
  await page.waitForURL(/two_factor|verif/i, { timeout: 30_000 }).catch(() => {});
  if (/two_factor|verif/i.test(page.url())) {
    const code = await getOtp(sinceEpochMs);
    // Single code field, or split inputs — fill the first textbox; adjust if split.
    const field = page.getByRole('textbox').first();
    await field.fill(code);
    await page
      .getByRole('button', { name: /verif|continuar|confirmar|enviar|submit/i })
      .first()
      .click();
  }
  await page.waitForURL((u) => !needsLogin(u.toString()), { timeout: 30_000 });
}

async function pullReportUrl(request, bearer, windowDays) {
  const headers = {
    authorization: bearer,
    'content-type': 'application/json',
    origin: APP,
    referer: `${APP}/`,
  };
  const end = new Date();
  const start = new Date(Date.now() - windowDays * 86_400_000);
  const body = {
    periods: [{ start_date: isoDate(start), end_date: isoDate(end) }],
    booking_date: 'start_time',
  };

  const post = await request.post(`${API}/booking_history`, { headers, data: body });
  if (!post.ok()) throw new Error(`booking_history POST ${post.status()}: ${await post.text()}`);
  const jobId = (await post.json()).file_uri;
  if (!jobId) throw new Error('booking_history returned no file_uri');

  // Poll the async generator until ready (value:true + an S3 url).
  for (let i = 0; i < 60; i++) {
    const check = await request.get(`${API}/check/${jobId}`, { headers });
    if (!check.ok()) throw new Error(`check GET ${check.status()}`);
    const j = await check.json();
    if (j.value && typeof j.file_uri === 'string') return j.file_uri;
    await sleep(2_000);
  }
  throw new Error('Report not ready within timeout (check poll)');
}

/**
 * @returns {Promise<{ s3Url: string, storageState: object }>}
 */
export async function acquireReportUrl({ email, password, getOtp, storageState, windowDays }) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext(storageState ? { storageState } : {});
    const page = await context.newPage();

    // Capture the Bearer the app attaches to its own API calls.
    let bearer = null;
    page.on('request', (req) => {
      const a = req.headers()['authorization'];
      if (a && /agendapro\.com\/api/.test(req.url())) bearer = a;
    });

    await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    if (needsLogin(page.url())) {
      await doLogin(page, { email, password, getOtp });
      await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    }
    // Let the app fire its API calls so we capture the Bearer.
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(2_000);

    if (!bearer) {
      const cookie = (await context.cookies()).find((c) => c.name === 'ap_cognito_authorization');
      if (cookie) bearer = decodeURIComponent(cookie.value);
    }
    if (!bearer) throw new Error('Could not obtain Authorization bearer after login');

    const s3Url = await pullReportUrl(context.request, bearer, windowDays);
    const newState = await context.storageState();
    return { s3Url, storageState: newState };
  } finally {
    await browser.close();
  }
}
