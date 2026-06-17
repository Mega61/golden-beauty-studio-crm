/**
 * Fetch the AgendaPro 2FA code from Gmail (read-only). Uses a Workspace service
 * account with domain-wide delegation, impersonating the mailbox that receives the
 * code. Only polls for messages that arrived AFTER login was triggered, so we never
 * reuse a stale code. Tightly scoped: gmail.readonly only. (Plan §2.1 OTP retrieval.)
 */
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeParts(payload) {
  // Concatenate all text/plain and text/html parts, base64url-decoded.
  let out = '';
  const walk = (p) => {
    if (!p) return;
    if (p.body?.data) out += Buffer.from(p.body.data, 'base64url').toString('utf8') + '\n';
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  return out;
}

/**
 * @param {object} o
 * @param {string} o.saKeyJson  Service-account key JSON (string).
 * @param {string} o.impersonate  Mailbox to read (the AgendaPro login email).
 * @param {string} o.sender  Expected sender, e.g. "noreply@agendapro.com".
 * @param {number} o.sinceEpochMs  Only accept emails newer than this.
 * @param {number} [o.timeoutMs=120000]
 * @param {number} [o.pollMs=5000]
 * @returns {Promise<string>} the 6-digit code
 */
export async function fetchLatestOtp({
  saKeyJson,
  impersonate,
  sender,
  sinceEpochMs,
  timeoutMs = 120_000,
  pollMs = 5_000,
}) {
  const creds = JSON.parse(saKeyJson);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
    subject: impersonate,
  });
  const gmail = google.gmail({ version: 'v1', auth });
  const query = `from:${sender} newer_than:1d`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 5 });
    for (const ref of list.data.messages ?? []) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
      if (Number(msg.data.internalDate) < sinceEpochMs) continue; // pre-login email
      const text = decodeParts(msg.data.payload);
      const code = text.match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await sleep(pollMs);
  }
  throw new Error(`No 2FA email from "${sender}" within ${timeoutMs / 1000}s`);
}
