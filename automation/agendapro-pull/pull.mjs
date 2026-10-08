/**
 * AgendaPro -> Strapi daily pull orchestrator (GitHub Actions cron).
 *
 * Flow: load cached session -> Playwright (login + email-2FA only if expired) ->
 * acquire the reports (reservations for CRM; transactions + sales for finance) ->
 * download each S3 xlsx -> POST to the matching Strapi intake. The session (cookies) is persisted to
 * SESSION_FILE so the browser/2FA only fires on expiry. The Actual Budget push runs as a
 * separate job (automation/actual-sync) off the Payment rows this creates.
 *
 * Fails loud (non-zero exit) on any error so the CI run goes red and notifies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchLatestOtp } from './lib/gmail-otp.mjs';
import { acquireReportUrl } from './lib/agendapro.mjs';
import { downloadReport, uploadToStrapi } from './lib/strapi.mjs';

function env(name, required = true, fallback = undefined) {
  // GitHub Actions renders an undefined `${{ vars.X }}` as an empty string, not as
  // an absent env var — so treat '' as missing, otherwise the fallback never applies
  // and `Number('')` silently becomes 0 (collapsing the report window to today).
  const raw = process.env[name];
  const v = raw === undefined || raw === '' ? fallback : raw;
  if (required && (v === undefined || v === '')) throw new Error(`Missing env ${name}`);
  return v;
}

function loadSession(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined; // first run / cache miss -> full login
  }
}

function saveSession(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

async function main() {
  const cfg = {
    email: env('AGENDAPRO_EMAIL'),
    password: env('AGENDAPRO_PASSWORD'),
    saKeyJson: env('GOOGLE_SA_KEY'),
    impersonate: env('GMAIL_IMPERSONATE'),
    otpSender: env('OTP_SENDER', false, 'noreply@agendapro.com'),
    ingestUrl: env('INGEST_URL'),
    // Transactions (money) intake. Defaults to the sibling route of INGEST_URL, so a
    // single INGEST_URL var keeps working with no extra config.
    ingestTransactionsUrl: env(
      'INGEST_TRANSACTIONS_URL',
      false,
      env('INGEST_URL').replace(/agendapro-report\b.*$/, 'agendapro-transactions'),
    ),
    // Sales intake (client + service of each sale), sibling route as above.
    ingestSalesUrl: env(
      'INGEST_SALES_URL',
      false,
      env('INGEST_URL').replace(/agendapro-report\b.*$/, 'agendapro-sales'),
    ),
    ingestSecret: env('INGEST_SHARED_SECRET'),
    windowDays: Number(env('WINDOW_DAYS', false, '35')),
    windowForwardDays: Number(env('WINDOW_FORWARD_DAYS', false, '30')),
    // Backward-only window for the money report. Small by default: the daily run only
    // needs recent payments, and a short window keeps re-ingests cheap (upsert by tx_id).
    financeWindowDays: Number(env('FINANCE_WINDOW_DAYS', false, '10')),
    sessionFile: env('SESSION_FILE', false, '.session/agendapro.json'),
  };

  const startedAt = new Date().toISOString();
  console.log(
    `[pull] start ${startedAt} (reservas -${cfg.windowDays}d..+${cfg.windowForwardDays}d, ` +
      `transacciones/ventas -${cfg.financeWindowDays}d)`,
  );

  const getOtp = (sinceEpochMs) =>
    fetchLatestOtp({
      saKeyJson: cfg.saKeyJson,
      impersonate: cfg.impersonate,
      sender: cfg.otpSender,
      sinceEpochMs,
    });

  const { s3Url, reportWindow, transactionsUrl, salesUrl, storageState } = await acquireReportUrl({
    email: cfg.email,
    password: cfg.password,
    getOtp,
    storageState: loadSession(cfg.sessionFile),
    windowDays: cfg.windowDays,
    windowForwardDays: cfg.windowForwardDays,
    financeWindowDays: cfg.financeWindowDays,
  });
  saveSession(cfg.sessionFile, storageState); // persist refreshed cookies
  const day = startedAt.slice(0, 10);

  // 1. Reservations report -> visits (CRM / winback).
  console.log('[pull] reservations report ready, downloading…');
  const buffer = await downloadReport(s3Url);
  console.log(`[pull] reservas ${buffer.length} bytes, uploading to Strapi…`);
  const result = await uploadToStrapi({
    url: cfg.ingestUrl,
    secret: cfg.ingestSecret,
    buffer,
    filename: `reservas_${day}.xlsx`,
    // The exact range the report covers, so Strapi can cancel the bookings that
    // vanished from it (e.g. a service changed in AgendaPro gets a new synthetic id).
    fields: { window_start: reportWindow.start, window_end: reportWindow.end },
  });
  console.log('[pull] reservas intake result:', JSON.stringify(result));

  // 2. Transactions report -> payments (finance / Actual Budget). Kept independent: a
  //    failure here still leaves the CRM ingest above committed.
  console.log('[pull] transactions report ready, downloading…');
  const txBuffer = await downloadReport(transactionsUrl);
  console.log(`[pull] transacciones ${txBuffer.length} bytes, uploading to Strapi…`);
  const txResult = await uploadToStrapi({
    url: cfg.ingestTransactionsUrl,
    secret: cfg.ingestSecret,
    buffer: txBuffer,
    filename: `transacciones_${day}.xlsx`,
  });
  console.log('[pull] transacciones intake result:', JSON.stringify(txResult));

  // 3. Sales report -> client/service names on those payments. After step 2: it labels
  //    the payments that step created, joined on sale_id. Only labels, so it warns
  //    instead of failing: the Actual sync (which needs this job green) must still run.
  try {
    if (!salesUrl) throw new Error('no sales report URL');
    console.log('[pull] sales report ready, downloading…');
    const salesBuffer = await downloadReport(salesUrl);
    console.log(`[pull] ventas ${salesBuffer.length} bytes, uploading to Strapi…`);
    const salesResult = await uploadToStrapi({
      url: cfg.ingestSalesUrl,
      secret: cfg.ingestSecret,
      buffer: salesBuffer,
      filename: `ventas_${day}.xlsx`,
    });
    console.log('[pull] ventas intake result:', JSON.stringify(salesResult));
  } catch (err) {
    console.warn('[pull] WARN sales labels skipped:', err?.message);
  }

  console.log(`[pull] OK ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error('[pull] FAILED:', err?.stack ?? err);
  process.exit(1);
});
