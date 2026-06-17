/**
 * AgendaPro -> Strapi daily pull orchestrator (GitHub Actions cron).
 *
 * Flow: load cached session -> Playwright (login + email-2FA only if expired) ->
 * POST report -> poll check -> download S3 xlsx -> POST to Strapi intake. The session
 * (cookies) is persisted to SESSION_FILE so the browser/2FA only fires on expiry.
 *
 * Fails loud (non-zero exit) on any error so the CI run goes red and notifies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchLatestOtp } from './lib/gmail-otp.mjs';
import { acquireReportUrl } from './lib/agendapro.mjs';
import { downloadReport, uploadToStrapi } from './lib/strapi.mjs';

function env(name, required = true, fallback = undefined) {
  const v = process.env[name] ?? fallback;
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
    ingestSecret: env('INGEST_SHARED_SECRET'),
    windowDays: Number(env('WINDOW_DAYS', false, '35')),
    sessionFile: env('SESSION_FILE', false, '.session/agendapro.json'),
  };

  const startedAt = new Date().toISOString();
  console.log(`[pull] start ${startedAt} (window ${cfg.windowDays}d)`);

  const getOtp = (sinceEpochMs) =>
    fetchLatestOtp({
      saKeyJson: cfg.saKeyJson,
      impersonate: cfg.impersonate,
      sender: cfg.otpSender,
      sinceEpochMs,
    });

  const { s3Url, storageState } = await acquireReportUrl({
    email: cfg.email,
    password: cfg.password,
    getOtp,
    storageState: loadSession(cfg.sessionFile),
    windowDays: cfg.windowDays,
  });
  saveSession(cfg.sessionFile, storageState); // persist refreshed cookies
  console.log('[pull] report ready, downloading…');

  const buffer = await downloadReport(s3Url);
  const filename = `reservas_${startedAt.slice(0, 10)}.xlsx`;
  console.log(`[pull] downloaded ${buffer.length} bytes, uploading to Strapi…`);

  const result = await uploadToStrapi({
    url: cfg.ingestUrl,
    secret: cfg.ingestSecret,
    buffer,
    filename,
  });
  console.log('[pull] intake result:', JSON.stringify(result));
  console.log(`[pull] OK ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error('[pull] FAILED:', err?.stack ?? err);
  process.exit(1);
});
