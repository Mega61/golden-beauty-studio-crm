/**
 * Ingest service — the ONE upsert path shared by the manual import (1.5) and the
 * future P2 AgendaPro intake route (2.3). Upserts Client by phone, Visit by booking_id.
 * Visit writes fire the lifecycle, which recomputes the client's countdown. See plan §3.
 */
import type { Core } from '@strapi/strapi';
import { mapCategory, type ServiceCategory } from '../../../winback/category';
import { statusFromEstado, type VisitStatus } from '../../../winback/compute';
import {
  normalizePhone,
  normalizeName,
  synthBookingId,
  parseAgendaProDate,
  parsePrice,
} from '../../../winback/normalize';

const CLIENT_UID = 'api::client.client';
const VISIT_UID = 'api::visit.visit';

/** A booking already normalized to our internal shape (what P2's route will POST). */
export interface NormalizedBooking {
  booking_id?: string | null;
  phone: string; // E.164
  full_name: string;
  email?: string | null;
  id_number?: string | null;
  service_name: string;
  service_category?: ServiceCategory;
  service_date: string; // ISO YYYY-MM-DD
  status: VisitStatus;
  source?: 'manual_import' | 'agendapro';
  price_list?: number | null;
  price_real?: number | null;
}

/** Raw AgendaPro export row, keyed by the Spanish column headers (verbatim). */
export interface AgendaProRawRow {
  fecha_realizacion?: string;
  nombre?: string;
  apellido?: string;
  email?: string;
  telefono?: string;
  identificacion?: string;
  servicio?: string;
  precio_lista?: string | number;
  precio_real?: string | number;
  estado?: string;
}

export interface IngestSummary {
  received: number;
  skipped_no_phone: number;
  skipped_bad_date: number;
  clients_created: number;
  clients_updated: number;
  visits_created: number;
  visits_updated: number;
  flagged_review: number;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /** Map a raw AgendaPro row to our normalized shape (or null if unusable). */
  normalizeRow(row: AgendaProRawRow): NormalizedBooking | { skip: 'no_phone' | 'bad_date' } {
    const phone = normalizePhone(row.telefono);
    if (!phone) return { skip: 'no_phone' };
    const service_date = parseAgendaProDate(row.fecha_realizacion);
    if (!service_date) return { skip: 'bad_date' };

    const full_name = `${row.nombre ?? ''} ${row.apellido ?? ''}`.replace(/\s+/g, ' ').trim();
    const service_name = (row.servicio ?? '').trim();

    return {
      phone,
      full_name,
      email: (row.email ?? '').trim() || null,
      id_number: (row.identificacion ?? '').trim() || null,
      service_name,
      service_category: mapCategory(service_name),
      service_date,
      status: statusFromEstado(row.estado ?? ''),
      source: 'manual_import',
      price_list: parsePrice(row.precio_lista),
      price_real: parsePrice(row.precio_real),
    };
  },

  /**
   * Upsert one normalized booking. Client by phone (canonical), Visit by booking_id.
   * Flags `needs_review` when a phone shows up under a different name (dirty data,
   * plan §1.2). Returns per-record effects so the caller can total them.
   */
  async upsertBooking(b: NormalizedBooking): Promise<{
    clientCreated: boolean;
    clientUpdated: boolean;
    visitCreated: boolean;
    visitUpdated: boolean;
    flaggedReview: boolean;
  }> {
    const result = {
      clientCreated: false,
      clientUpdated: false,
      visitCreated: false,
      visitUpdated: false,
      flaggedReview: false,
    };

    const category = b.service_category ?? mapCategory(b.service_name);

    // --- Client upsert by phone ---
    const existingClients = (await strapi.documents(CLIENT_UID).findMany({
      filters: { phone: b.phone },
      limit: 1,
    })) as any[];
    let clientDocumentId: string;

    if (existingClients.length === 0) {
      const created = (await strapi.documents(CLIENT_UID).create({
        data: {
          phone: b.phone,
          full_name: b.full_name || b.phone,
          email: b.email ?? undefined,
          id_number: b.id_number ?? undefined,
        } as any,
      })) as any;
      clientDocumentId = created.documentId;
      result.clientCreated = true;
    } else {
      const existing = existingClients[0];
      clientDocumentId = existing.documentId;
      const patch: Record<string, unknown> = {};

      // Different name on the same phone ⇒ dirty data, flag for Mariana (don't block).
      // Only write when something actually changes, so re-imports are true no-ops.
      if (
        b.full_name &&
        existing.full_name &&
        normalizeName(existing.full_name) !== normalizeName(b.full_name)
      ) {
        const noteHasName =
          existing.review_note && String(existing.review_note).includes(b.full_name);
        if (!existing.needs_review) patch.needs_review = true;
        if (!noteHasName) {
          const note = `Phone shared by: "${existing.full_name}" and "${b.full_name}".`;
          patch.review_note = existing.review_note ? `${existing.review_note} ${note}` : note;
        }
        if ('needs_review' in patch || 'review_note' in patch) result.flaggedReview = true;
      }
      // Backfill email/id when we learn them and they were empty.
      if (b.email && !existing.email) patch.email = b.email;
      if (b.id_number && !existing.id_number) patch.id_number = b.id_number;

      if (Object.keys(patch).length > 0) {
        await strapi.documents(CLIENT_UID).update({ documentId: clientDocumentId, data: patch as any });
        result.clientUpdated = true;
      }
    }

    // --- Visit upsert by booking_id ---
    const booking_id = b.booking_id || synthBookingId(b.phone, b.service_date, b.service_name);
    const existingVisits = (await strapi.documents(VISIT_UID).findMany({
      filters: { booking_id },
      limit: 1,
    })) as any[];

    const visitData = {
      booking_id,
      client: clientDocumentId,
      service_name: b.service_name,
      service_category: category,
      service_date: b.service_date,
      status: b.status,
      source: b.source ?? 'manual_import',
      price_list: b.price_list ?? undefined,
      price_real: b.price_real ?? undefined,
    };

    if (existingVisits.length === 0) {
      await strapi.documents(VISIT_UID).create({ data: visitData as any });
      result.visitCreated = true;
    } else {
      await strapi.documents(VISIT_UID).update({
        documentId: existingVisits[0].documentId,
        data: visitData as any,
      });
      result.visitUpdated = true;
    }

    return result;
  },

  /** Upsert many already-normalized bookings (P2 intake route entry point). */
  async upsertMany(bookings: NormalizedBooking[]): Promise<IngestSummary> {
    const summary: IngestSummary = {
      received: bookings.length,
      skipped_no_phone: 0,
      skipped_bad_date: 0,
      clients_created: 0,
      clients_updated: 0,
      visits_created: 0,
      visits_updated: 0,
      flagged_review: 0,
    };
    for (const b of bookings) {
      const r = await this.upsertBooking(b);
      if (r.clientCreated) summary.clients_created++;
      if (r.clientUpdated) summary.clients_updated++;
      if (r.visitCreated) summary.visits_created++;
      if (r.visitUpdated) summary.visits_updated++;
      if (r.flaggedReview) summary.flagged_review++;
    }
    return summary;
  },

  /** Ingest raw AgendaPro export rows (manual import entry point). */
  async ingestAgendaProRows(rows: AgendaProRawRow[]): Promise<IngestSummary> {
    const normalized: NormalizedBooking[] = [];
    let skipped_no_phone = 0;
    let skipped_bad_date = 0;

    for (const row of rows) {
      const n = this.normalizeRow(row);
      if ('skip' in n) {
        if (n.skip === 'no_phone') skipped_no_phone++;
        else skipped_bad_date++;
        continue;
      }
      normalized.push(n);
    }

    const summary = await this.upsertMany(normalized);
    summary.received = rows.length;
    summary.skipped_no_phone = skipped_no_phone;
    summary.skipped_bad_date = skipped_bad_date;
    return summary;
  },
});
