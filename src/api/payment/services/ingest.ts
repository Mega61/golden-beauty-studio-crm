/**
 * Payment ingest service — the ONE upsert path for the AgendaPro transactions report,
 * feeding the Actual Budget sync. Upserts Payment by tx_id (idempotent re-imports).
 *
 * Flow: reservations → Visit (CRM/winback); transactions → Payment (money/finance).
 * The two reports are independent; this one carries the payment method (cash vs
 * transfer) that the reservations report lacks, which is what lets the sync route each
 * income to the right Actual account.
 *
 * The sales report (ingestSalesFile) then fills in client_name / service_name on the
 * payments of each sale, joined on sale_id, so Actual shows who paid instead of a bare
 * "Venta N".
 */
import type { Core } from '@strapi/strapi';
import { normalizeName, parseAgendaProDate, parseMoney } from '../../../winback/normalize';
import {
  parseAgendaProTxWorkbook,
  type AgendaProTxRawRow,
} from '../../../winback/agendapro-transactions-xlsx';
import { parseAgendaProSalesWorkbook } from '../../../winback/agendapro-sales-xlsx';

const PAYMENT_UID = 'api::payment.payment';
const CLIENT_UID = 'api::client.client';

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
  client_name: string | null;
  /** The client's phone, looked up by name in the CRM (null when unknown or ambiguous). */
  client_phone: string | null;
  service_name: string | null;
  paid_at: string;
  amount: number;
  tip: number;
  method: PaymentMethod;
  payment_status: string | null;
  synced_to_actual: boolean;
}

export interface SalesIngestSummary {
  received: number;
  payments_enriched: number;
  sales_without_payment: number;
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
   * Fill client_name / service_name on every payment of each sale in a sales workbook.
   * Only writes when a value changed, so the nightly re-ingest is a no-op. A sale with no
   * payment yet (paid later, or outside the transactions window) is just counted: its
   * payment picks the names up on a later run whose sales window still covers it.
   */
  async ingestSalesFile(input: string | Buffer): Promise<SalesIngestSummary> {
    const sales = parseAgendaProSalesWorkbook(input);
    const summary: SalesIngestSummary = {
      received: sales.length,
      payments_enriched: 0,
      sales_without_payment: 0,
    };
    for (const sale of sales) {
      const payments = (await strapi.documents(PAYMENT_UID).findMany({
        filters: { sale_id: sale.sale_id },
      })) as any[];
      if (payments.length === 0) {
        summary.sales_without_payment++;
        continue;
      }
      for (const p of payments) {
        const client_name = sale.client_name ?? p.client_name ?? null;
        const service_name = sale.service_name ?? p.service_name ?? null;
        if (p.client_name === client_name && p.service_name === service_name) continue;
        await strapi.documents(PAYMENT_UID).update({
          documentId: p.documentId,
          data: { client_name, service_name } as any,
        });
        summary.payments_enriched++;
      }
    }
    return summary;
  },

  /**
   * Client phone by normalized full name. The sales report names the client but has no
   * phone; the reservations report gives both, and AgendaPro writes the same "Nombre
   * Apellido" in each, so the name bridges a payment to its client. A name two clients
   * share maps to nothing rather than to a guess.
   */
  async phonesByName(): Promise<Map<string, string>> {
    const PAGE = 200;
    const phones = new Map<string, Set<string>>();
    for (let start = 0; ; start += PAGE) {
      const page = (await strapi.documents(CLIENT_UID).findMany({
        fields: ['full_name', 'phone'] as any,
        start,
        limit: PAGE,
      })) as any[];
      for (const c of page) {
        const key = normalizeName(c.full_name);
        if (!key || !c.phone) continue;
        if (!phones.has(key)) phones.set(key, new Set());
        phones.get(key)!.add(c.phone);
      }
      if (page.length < PAGE) break;
    }
    const unique = new Map<string, string>();
    for (const [name, set] of phones) if (set.size === 1) unique.set(name, [...set][0]);
    return unique;
  },

  /**
   * Income rows on/after `since` (YYYY-MM-DD), by default only those not yet pushed to
   * Actual. `since` is the cutover guard that keeps the sync from colliding with income
   * entered by hand before automation was switched on. `all` also returns the synced
   * ones, so the sync can bring their Actual notes up to date. Ordered oldest-first for
   * stable, replayable imports.
   */
  async listIncomes({ since, all = false }: { since?: string; all?: boolean } = {}): Promise<
    IncomeRow[]
  > {
    const filters: Record<string, unknown> = all ? {} : { synced_to_actual: { $eq: false } };
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

    const phoneOf = await this.phonesByName();
    return rows.map((r) => ({
      tx_id: r.tx_id,
      sale_id: r.sale_id ?? null,
      client_name: r.client_name ?? null,
      client_phone: r.client_name ? (phoneOf.get(normalizeName(r.client_name)) ?? null) : null,
      service_name: r.service_name ?? null,
      paid_at: r.paid_at,
      amount: r.amount,
      tip: r.tip ?? 0,
      method: r.method as PaymentMethod,
      payment_status: r.payment_status ?? null,
      synced_to_actual: Boolean(r.synced_to_actual),
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
