/**
 * Payment ingest service — the ONE upsert path for the AgendaPro transactions report,
 * feeding the Actual Budget sync. Upserts Payment by tx_id (idempotent re-imports).
 *
 * Flow: reservations → Visit (CRM/winback); transactions → Payment (money/finance).
 * The two reports are independent; this one carries the payment method (cash vs
 * transfer) that the reservations report lacks, which is what lets the sync route each
 * income to the right Actual account.
 */
import type { Core } from '@strapi/strapi';
import { parseAgendaProDate, parseMoney } from '../../../winback/normalize';
import {
  parseAgendaProTxWorkbook,
  type AgendaProTxRawRow,
} from '../../../winback/agendapro-transactions-xlsx';

const PAYMENT_UID = 'api::payment.payment';

export type PaymentMethod = 'efectivo' | 'transferencia' | 'otro';

/** A transactions row normalized to our internal shape. */
export interface NormalizedPayment {
  tx_id: string;
  sale_id?: string | null;
  paid_at: string; // ISO YYYY-MM-DD (payment date — cash basis)
  amount: number; // COP integer
  tip: number; // COP integer
  method: PaymentMethod;
  payment_status?: string | null;
}

/** An income row shaped for the Actual sync (money-in, method already resolved). */
export interface IncomeRow {
  tx_id: string;
  sale_id: string | null;
  paid_at: string;
  amount: number;
  tip: number;
  method: PaymentMethod;
  payment_status: string | null;
}

export interface PaymentIngestSummary {
  received: number;
  skipped_no_id: number;
  skipped_bad_date: number;
  skipped_no_amount: number;
  payments_created: number;
  payments_updated: number;
}

/** Map AgendaPro's free-text payment method to our enum. Unknowns fall to `otro`. */
export function mapPaymentMethod(raw: string | null | undefined): PaymentMethod {
  const n = String(raw ?? '')
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .trim()
    .toLowerCase();
  if (n.includes('efectivo')) return 'efectivo';
  if (n.includes('transferencia') || n.includes('bancolombia') || n.includes('nequi')) {
    return 'transferencia';
  }
  return 'otro';
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /** Map a raw transactions row to our normalized shape (or a skip reason). */
  normalizeRow(
    row: AgendaProTxRawRow,
  ): NormalizedPayment | { skip: 'no_id' | 'bad_date' | 'no_amount' } {
    const tx_id = String(row.id ?? '').trim();
    if (!tx_id) return { skip: 'no_id' };

    const paid_at = parseAgendaProDate(row.fecha);
    if (!paid_at) return { skip: 'bad_date' };

    const amount = parseMoney(row.monto);
    if (amount === null) return { skip: 'no_amount' };

    return {
      tx_id,
      sale_id: String(row.id_venta ?? '').trim() || null,
      paid_at,
      amount,
      tip: parseMoney(row.propina) ?? 0,
      method: mapPaymentMethod(row.metodo_pago),
      payment_status: String(row.estado_pago ?? '').trim() || null,
    };
  },

  /** Upsert one payment by tx_id. Re-imports are true no-ops unless a field changed. */
  async upsertPayment(p: NormalizedPayment): Promise<{ created: boolean; updated: boolean }> {
    const existing = (await strapi.documents(PAYMENT_UID).findMany({
      filters: { tx_id: p.tx_id },
      limit: 1,
    })) as any[];

    // Only the source fields — never touch synced_to_actual / actual_txn_id here, so a
    // re-ingest can't silently un-sync a payment already pushed to Actual.
    const data = {
      tx_id: p.tx_id,
      sale_id: p.sale_id ?? undefined,
      paid_at: p.paid_at,
      amount: p.amount,
      tip: p.tip,
      method: p.method,
      payment_status: p.payment_status ?? undefined,
    };

    if (existing.length === 0) {
      await strapi.documents(PAYMENT_UID).create({ data: data as any });
      return { created: true, updated: false };
    }
    await strapi.documents(PAYMENT_UID).update({
      documentId: existing[0].documentId,
      data: data as any,
    });
    return { created: false, updated: true };
  },

  /** Ingest raw transactions rows (shared by the intake route and any manual import). */
  async ingestTransactionsRows(rows: AgendaProTxRawRow[]): Promise<PaymentIngestSummary> {
    const summary: PaymentIngestSummary = {
      received: rows.length,
      skipped_no_id: 0,
      skipped_bad_date: 0,
      skipped_no_amount: 0,
      payments_created: 0,
      payments_updated: 0,
    };

    for (const row of rows) {
      const n = this.normalizeRow(row);
      if ('skip' in n) {
        if (n.skip === 'no_id') summary.skipped_no_id++;
        else if (n.skip === 'bad_date') summary.skipped_bad_date++;
        else summary.skipped_no_amount++;
        continue;
      }
      const r = await this.upsertPayment(n);
      if (r.created) summary.payments_created++;
      if (r.updated) summary.payments_updated++;
    }
    return summary;
  },

  /** Ingest a transactions workbook from a file path or buffer (intake entry point). */
  async ingestTransactionsFile(input: string | Buffer): Promise<PaymentIngestSummary> {
    const rows = parseAgendaProTxWorkbook(input);
    return this.ingestTransactionsRows(rows);
  },

  /**
   * Income rows not yet pushed to Actual, on/after `since` (YYYY-MM-DD). `since` is the
   * cutover guard that keeps the sync from colliding with income entered by hand before
   * automation was switched on. Ordered oldest-first for stable, replayable imports.
   */
  async listUnsynced({ since }: { since?: string } = {}): Promise<IncomeRow[]> {
    const filters: Record<string, unknown> = { synced_to_actual: { $eq: false } };
    if (since) filters.paid_at = { $gte: since };

    // Paginate: the Document Service defaults to a 25-row page, so a larger backfill
    // would be silently truncated by a single findMany.
    const PAGE = 100;
    const rows: any[] = [];
    for (let start = 0; ; start += PAGE) {
      const page = (await strapi.documents(PAYMENT_UID).findMany({
        filters: filters as any,
        sort: ['paid_at:asc', 'tx_id:asc'] as any,
        start,
        limit: PAGE,
      })) as any[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }

    return rows.map((r) => ({
      tx_id: r.tx_id,
      sale_id: r.sale_id ?? null,
      paid_at: r.paid_at,
      amount: r.amount,
      tip: r.tip ?? 0,
      method: r.method as PaymentMethod,
      payment_status: r.payment_status ?? null,
    }));
  },

  /**
   * Flag payments as synced once Actual has accepted them, recording Actual's own txn id
   * for traceability. Idempotent: unknown tx_ids are ignored.
   */
  async markSynced(
    synced: Array<{ tx_id: string; actual_txn_id?: string | null }>,
  ): Promise<{ marked: number }> {
    let marked = 0;
    for (const s of synced) {
      const existing = (await strapi.documents(PAYMENT_UID).findMany({
        filters: { tx_id: s.tx_id },
        limit: 1,
      })) as any[];
      if (existing.length === 0) continue;
      await strapi.documents(PAYMENT_UID).update({
        documentId: existing[0].documentId,
        data: { synced_to_actual: true, actual_txn_id: s.actual_txn_id ?? undefined } as any,
      });
      marked++;
    }
    return { marked };
  },
});
