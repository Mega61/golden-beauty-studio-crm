/**
 * Validation of the admin panel's nightly payments push (POST /api/ingest/payments).
 * Pure (no Strapi, no imports) so it can be unit-tested with `node --test`.
 */

export type PaymentMethod = 'efectivo' | 'transferencia' | 'otro';

/** A payment ready to upsert (same shape the AgendaPro path produces). */
export interface NormalizedPayment {
  tx_id: string;
  sale_id?: string | null;
  paid_at: string; // ISO YYYY-MM-DD (payment date — cash basis)
  amount: number; // COP integer
  tip: number; // COP integer
  method: PaymentMethod;
  payment_status?: string | null;
  /** Only the admin panel sends these; the AgendaPro path gets them from the sales report. */
  client_name?: string | null;
  service_name?: string | null;
}

/**
 * Panel payments are keyed `ea-appt:<id>` (plus `:<method>` for a split bill and
 * `:adj<n>` for a post-close correction). The prefix is what keeps them from ever
 * colliding with AgendaPro's numeric tx ids, so the JSON route accepts nothing else.
 */
export const PANEL_TX_PREFIX = 'ea-appt:';

/**
 * Gift card sales from the panel are keyed `bono:<code>` (code `TR-XXXX-XXXX`), plus
 * `:adj<n>` for a void after the sale was already pushed (a negative movement). They are
 * money in, not visits: they never create a Visit, a Client or a Stampee stamp.
 */
export const GIFT_CARD_TX_PREFIX = 'bono:';
const GIFT_CARD_TX_RE = /^bono:TR-[0-9A-Z]{4}-[0-9A-Z]{4}(?::adj[1-9]\d*)?$/;

/**
 * Deposits ("adelantos") are keyed `abono:<id>` (the panel's `appointment_deposit` id),
 * plus `:adj<n>` for a refund after the deposit was already pushed (a negative movement).
 * Money paid days or weeks before the appointment, on the day it came in: like gift card
 * sales, they never create a Visit, a Client or a Stampee stamp. The appointment's own
 * payment arrives later as `ea-appt:<id>`, without the deposit inside.
 */
export const DEPOSIT_TX_PREFIX = 'abono:';
const DEPOSIT_TX_RE = /^abono:[1-9]\d*(?::adj[1-9]\d*)?$/;

/** True for a tx_id the panel may send. */
export function isPanelTxId(tx_id: string): boolean {
  if (tx_id.startsWith(PANEL_TX_PREFIX)) return tx_id.length > PANEL_TX_PREFIX.length;
  return GIFT_CARD_TX_RE.test(tx_id) || DEPOSIT_TX_RE.test(tx_id);
}

/** True for a deposit (or its refund), as opposed to an appointment payment. */
export function isDepositTxId(tx_id: string | null | undefined): boolean {
  return String(tx_id ?? '').startsWith(DEPOSIT_TX_PREFIX);
}

/** True for a gift card sale (or its adjustment), as opposed to an appointment payment. */
export function isGiftCardTxId(tx_id: string | null | undefined): boolean {
  return String(tx_id ?? '').startsWith(GIFT_CARD_TX_PREFIX);
}

/**
 * Validate a JSON batch from the admin panel. All-or-nothing: one bad row rejects the
 * whole batch (400), so a broken contract fails loud instead of landing half a day in
 * Actual. Returns the rows ready to upsert, or the first error.
 */
export function validatePanelPayments(
  rows: unknown,
): { ok: true; rows: NormalizedPayment[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: 'Expected JSON body { payments: [...] }.' };
  const out: NormalizedPayment[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of rows.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const where = `payments[${i}]`;
    const tx_id = typeof r.tx_id === 'string' ? r.tx_id.trim() : '';
    if (!isPanelTxId(tx_id)) {
      return {
        ok: false,
        error:
          `${where}.tx_id must start with "${PANEL_TX_PREFIX}" ` +
          `or be "${GIFT_CARD_TX_PREFIX}TR-XXXX-XXXX[:adj<n>]" or "${DEPOSIT_TX_PREFIX}<id>[:adj<n>]"`,
      };
    }
    if (seen.has(tx_id)) return { ok: false, error: `${where}.tx_id ${tx_id} is repeated in the batch` };
    seen.add(tx_id);
    const paid_at = typeof r.paid_at === 'string' ? r.paid_at : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paid_at)) return { ok: false, error: `${where}.paid_at must be YYYY-MM-DD` };
    // Signed: a post-close correction travels as its own (possibly negative) movement.
    if (!Number.isSafeInteger(r.amount)) return { ok: false, error: `${where}.amount must be an integer` };
    const tip = r.tip ?? 0;
    if (!Number.isSafeInteger(tip) || (tip as number) < 0) {
      return { ok: false, error: `${where}.tip must be a non-negative integer` };
    }
    if (r.method !== 'efectivo' && r.method !== 'transferencia' && r.method !== 'otro') {
      return { ok: false, error: `${where}.method must be efectivo | transferencia | otro` };
    }
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 255) : null);
    out.push({
      tx_id,
      paid_at,
      amount: r.amount as number,
      tip: tip as number,
      method: r.method,
      client_name: text(r.client_name),
      service_name: text(r.service_name),
    });
  }
  return { ok: true, rows: out };
}
