/**
 * AgendaPro acquisition via Playwright. Reuses a cached session (cookies) and only
 * performs the email-2FA login when the session has expired. Once authenticated it
 * obtains a Cognito Bearer (from the app's own API calls or its cookies), runs the
 * report API, polls until ready, and returns the S3 download URL. See plan §2.1 / §2.2.
 *
 * On any failure it writes a screenshot + URL + cookie-name dump to ./debug for the
 * workflow to upload as an artifact (the only way to see what the headless run hit).
 *
 * ⚠️ SELECTORS TO VERIFY against the real login page — they use accessible labels/roles.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const APP = 'https://app.agendapro.com';
const REPORTS_URL = `${APP}/bookings-reports/history`;
const API = 'https://agendapro.com/api/views/admin/v2/reports/files';
const DEBUG_DIR = 'debug';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) => d.toISOString().slice(0, 10);
const needsLogin = (url) => /sign_in|sign-in|two_factor|\/login/i.test(url);
const looksLikeJwt = (v) => typeof v === 'string' && /eyJ[\w-]+\.[\w-]+\./.test(v);

async function dumpDebug(page, context, label) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: `${DEBUG_DIR}/${label}.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${DEBUG_DIR}/${label}-url.txt`, page.url());
    const cookies = await context.cookies().catch(() => []);
    fs.writeFileSync(
      `${DEBUG_DIR}/${label}-cookies.txt`,
      cookies.map((c) => `${c.domain}\t${c.name}=${String(c.value).slice(0, 16)}…`).join('\n'),
    );
    fs.writeFileSync(`${DEBUG_DIR}/${label}.html`, (await page.content().catch(() => '')).slice(0, 300_000));
    console.log(`[agendapro] wrote debug artifacts: ${DEBUG_DIR}/${label}.*`);
  } catch (e) {
    console.log('[agendapro] debug dump failed:', e?.message);
  }
}

async function bearerFromCookies(context) {
  const cookies = await context.cookies();
  // Prefer an explicit authorization cookie; otherwise any cookie carrying a JWT.
  for (const c of cookies) {
    if (/authorization|cognito/i.test(c.name)) {
      const v = decodeURIComponent(c.value || '').replace(/^Bearer\s+/i, '');
      if (looksLikeJwt(v)) return `Bearer ${v}`;
    }
  }
  for (const c of cookies) {
    const v = decodeURIComponent(c.value || '').replace(/^Bearer\s+/i, '');
    if (looksLikeJwt(v)) return `Bearer ${v}`;
  }
  return null;
}

// The login form has no <label>s — target inputs by name (placeholders:
// "user@example.com" / "Enter your password"); the submit button reads "Log in"
// and starts disabled until both fields are filled (Playwright auto-waits for enabled).
async function isLoggedOut(page) {
  if (needsLogin(page.url())) return true;
  const emailFields = await page.locator('input[name="email"]').count().catch(() => 0);
  return emailFields > 0;
}

async function doLogin(page, { email, password, getOtp }) {
  console.log('[agendapro] logging in…');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  const sinceEpochMs = Date.now();
  await page.getByRole('button', { name: /log ?in|iniciar|ingresar|continuar/i }).first().click();

  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(2_500);

  if (/two_factor|verif/i.test(page.url())) {
    console.log('[agendapro] 2FA prompt detected, fetching code…');
    const code = await getOtp(sinceEpochMs);
    await page.getByRole('textbox').first().fill(code);
    await page
      .getByRole('button', { name: /verif|continuar|confirmar|enviar|submit|log ?in/i })
      .first()
      .click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(2_500);
  } else {
    console.log('[agendapro] no 2FA prompt; url:', page.url());
  }
}

async function pullReportUrl(request, bearer, windowDays) {
  const headers = { authorization: bearer, 'content-type': 'application/json', origin: APP, referer: `${APP}/` };
  const end = new Date();
  const start = new Date(Date.now() - windowDays * 86_400_000);
  const body = { periods: [{ start_date: isoDate(start), end_date: isoDate(end) }], booking_date: 'start_time' };

  const post = await request.post(`${API}/booking_history`, { headers, data: body });
  if (!post.ok()) throw new Error(`booking_history POST ${post.status()}: ${await post.text()}`);
  const jobId = (await post.json()).file_uri;
  if (!jobId) throw new Error('booking_history returned no file_uri');

  for (let i = 0; i < 60; i++) {
    const check = await request.get(`${API}/check/${jobId}`, { headers });
    if (!check.ok()) throw new Error(`check GET ${check.status()}`);
    const j = await check.json();
    if (j.value && typeof j.file_uri === 'string') return j.file_uri;
    await sleep(2_000);
  }
  throw new Error('Report not ready within timeout (check poll)');
}

/** @returns {Promise<{ s3Url: string, storageState: object }>} */
export async function acquireReportUrl({ email, password, getOtp, storageState, windowDays }) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  let context;
  let page;
  try {
    context = await browser.newContext(storageState ? { storageState } : {});
    page = await context.newPage();

    // Capture the Bearer from the app's API calls — at both page and context level
    // (context catches service-worker / cross-frame requests that page.on misses).
    let bearer = null;
    const grab = (req) => {
      const a = req.headers()['authorization'];
      if (a && /agendapro\.com\/api/.test(req.url())) bearer = a;
    };
    page.on('request', grab);
    context.on('request', grab);

    await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    // SPA: it redirects to /sign_in client-side AFTER load, so settle before deciding.
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(2_500);
    console.log('[agendapro] url after settle:', page.url(), '| loggedOut:', await isLoggedOut(page));

    if (await isLoggedOut(page)) {
      await doLogin(page, { email, password, getOtp });
      await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(2_500);
      console.log('[agendapro] url after login+goto:', page.url());
      if (await isLoggedOut(page)) {
        await dumpDebug(page, context, 'login-failed');
        throw new Error('Login did not complete (still logged out after submit)');
      }
    }

    // Give the app time to fire its authenticated API calls; reload once to force them.
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(2_000);
    if (!bearer) {
      await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
      await sleep(2_000);
    }
    console.log('[agendapro] bearer from request:', Boolean(bearer));

    if (!bearer) {
      bearer = await bearerFromCookies(context);
      console.log('[agendapro] bearer from cookies:', Boolean(bearer));
    }
    if (!bearer) {
      await dumpDebug(page, context, 'no-bearer');
      throw new Error('Could not obtain Authorization bearer after login');
    }

    const s3Url = await pullReportUrl(context.request, bearer, windowDays);
    const newState = await context.storageState();
    return { s3Url, storageState: newState };
  } catch (err) {
    if (page && context) await dumpDebug(page, context, 'failure');
    throw err;
  } finally {
    await browser.close();
  }
}
