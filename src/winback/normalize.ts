/**
 * Shared normalization helpers for ingestion (manual import now, P2 intake later).
 * Pure + dependency-light so they can be unit-tested and reused everywhere.
 */
import { createHash } from 'crypto';

/**
 * Normalize a Colombian phone to E.164 (`+57XXXXXXXXXX`).
 * Returns null when there aren't enough digits to be a real mobile.
 * Phone is the canonical client identity (plan §1.2), so this must be deterministic.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);
  return `+57${last10}`;
}

/** Collapsed, accent-stripped, lower-cased name for equality checks (not for display). */
export function normalizeName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Deterministic idempotency key for visits when AgendaPro gives no stable booking id.
 * Same (phone, date, service) always hashes to the same id ⇒ re-import is idempotent.
 */
export function synthBookingId(phone: string, serviceDateIso: string, serviceName: string): string {
  const basis = `${phone}|${serviceDateIso}|${normalizeName(serviceName)}`;
  return `gen_${createHash('sha1').update(basis).digest('hex').slice(0, 24)}`;
}

/**
 * Parse AgendaPro's `DD/MM/YYYY[ HH:mm]` into an ISO `YYYY-MM-DD` (date only).
 * Returns null on anything unparseable.
 */
export function parseAgendaProDate(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year = m[3];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${month}-${day}`;
}

/** Parse a Colombian price string/number to an integer COP (or null). */
export function parsePrice(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (!digits) return null;
  return Number(digits);
}

/**
 * Parse a *formatted* money value to whole COP. Unlike `parsePrice` (which just keeps
 * digits — fine for the plain integers in the reservations report), this handles the
 * transactions report's thousands separators and decimals, e.g. "30,000.00" → 30000 and
 * "30.000,00" → 30000. Cents are dropped (COP is whole-peso). Returns null if unparseable.
 *
 * Decimal separator detection: when both '.' and ',' appear, the last one is the decimal
 * sep; a lone separator counts as decimal only when it's the single separator with 1–2
 * trailing digits (otherwise it's thousands grouping).
 */
export function parseMoney(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;

  const s = String(raw).trim().replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decSep: '.' | ',' | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decSep = lastDot > lastComma ? '.' : ',';
  } else if (lastComma >= 0) {
    const trailing = s.length - lastComma - 1;
    decSep = s.split(',').length === 2 && (trailing === 1 || trailing === 2) ? ',' : null;
  } else if (lastDot >= 0) {
    const trailing = s.length - lastDot - 1;
    decSep = s.split('.').length === 2 && (trailing === 1 || trailing === 2) ? '.' : null;
  }

  const intText = (decSep ? s.slice(0, s.lastIndexOf(decSep)) : s).replace(/[.,]/g, '');
  if (!intText || intText === '-') return null;
  const n = Number(intText);
  return Number.isFinite(n) ? n : null;
}
