/**
 * Stampee fidelization integration (phone-only, plan: stampee-integration-plan.md).
 * - crosscheck(): match Stampee customers' `mobile` ↔ Strapi `Client.phone`, stamp each
 *   client `matched | sin_tarjeta` (read-only).
 * - syncFromApi(): fetch customers+cards live from the Stampee API → crosscheck →
 *   optionally ensure every attended client has a card (create customer + issue card).
 */
import type { Core } from '@strapi/strapi';
import { normalizePhone } from '../../../winback/normalize';
import {
  stampeeConfigured,
  listCustomersWithCards,
  listCampaigns,
  createCustomer,
  issueCard,
  patchCard,
  addCardTransaction,
  type StampeeCustomerApi,
  type StampeeCard,
} from '../../../winback/stampee-client';

const CLIENT_UID = 'api::client.client';
const VISIT_UID = 'api::visit.visit';
const INTERNAL_EMAIL = '@goldenbeautystudio';

export interface StampeeCustomer {
  id: string;
  name: string;
  email?: string | null;
  mobile?: string | null;
  status?: string;
  cards?: StampeeCard[];
}

export interface CrosscheckSummary {
  customers_total: number;
  internal_skipped: number;
  clients_total: number;
  matched: number;
  sin_tarjeta: number;
  /** Strapi clients with no Stampee card → "issue a card" list for Mariana. */
  sin_tarjeta_names: string[];
  /** Stampee customers with no usable mobile → "add the phone in Stampee" list. */
  stampee_missing_mobile: string[];
}

const last10 = (raw: string | null | undefined): string | null => {
  const n = normalizePhone(raw);
  return n ? n.slice(-10) : null;
};

/** The active (non-redeemed) card with the most progress — the one whose count we display. */
const activeCard = (cards: StampeeCard[] | undefined): StampeeCard | undefined =>
  (cards ?? [])
    .filter((cd) => (cd.status ?? 'Active') !== 'Redeemed')
    .sort((a, b) => (b.stamps ?? 0) - (a.stamps ?? 0))[0];

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * The campaign stamp goal (e.g. 8), preferring the live campaign's `totalStamps` and
   * falling back to STAMPEE_STAMP_GOAL. Used both to display "n/goal" and to cap stamping.
   */
  async resolveStampGoal(): Promise<number | null> {
    try {
      const campaigns = await listCampaigns();
      const pinned = process.env.STAMPEE_CAMPAIGN_ID;
      const enabled = campaigns.filter((c) => c.isEnabled !== false);
      const pick = pinned
        ? campaigns.find((c) => c.id === pinned)
        : enabled.length === 1
          ? enabled[0]
          : campaigns.length === 1
            ? campaigns[0]
            : undefined;
      if (pick && typeof pick.totalStamps === 'number' && pick.totalStamps > 0) return pick.totalStamps;
    } catch {
      /* fall back to env */
    }
    const envGoal = Number(process.env.STAMPEE_STAMP_GOAL);
    return Number.isFinite(envGoal) && envGoal > 0 ? envGoal : null;
  },

  async crosscheck(
    customers: StampeeCustomer[],
    opts: { goal?: number | null } = {},
  ): Promise<CrosscheckSummary> {
    // 1. Drop internal staff/owner Stampee logins.
    const external = customers.filter((c) => !String(c.email ?? '').includes(INTERNAL_EMAIL));
    const internal_skipped = customers.length - external.length;

    // 2. Index customers by phone (carries their cards); collect those with no usable mobile.
    const byPhone = new Map<string, StampeeCustomer>();
    const stampee_missing_mobile: string[] = [];
    for (const c of external) {
      const l = last10(c.mobile);
      if (l) byPhone.set(l, c);
      else stampee_missing_mobile.push(c.name);
    }

    // 3. Stamp each Strapi client matched / sin_tarjeta, and mirror the live stamp count.
    const clients = (await strapi.documents(CLIENT_UID).findMany({ limit: 1000 })) as any[];
    const goal = opts.goal ?? null;
    let matched = 0;
    const sin_tarjeta_names: string[] = [];

    for (const cl of clients) {
      const l = last10(cl.phone);
      const cust = l ? byPhone.get(l) : undefined;
      const status: 'matched' | 'sin_tarjeta' = cust ? 'matched' : 'sin_tarjeta';
      if (status === 'matched') matched++;
      else sin_tarjeta_names.push(cl.full_name || cl.phone);

      // Live stamps from the active card (null when matched-but-no-card, or no match at all).
      const card = cust ? activeCard(cust.cards) : undefined;
      const stamps = card ? Number(card.stamps ?? 0) : null;

      const updates: Record<string, unknown> = {};
      if (cl.stampee_card !== status) updates.stampee_card = status;
      if ((cl.stampee_stamps ?? null) !== stamps) updates.stampee_stamps = stamps;
      if (goal != null && cl.stampee_card_goal !== goal) updates.stampee_card_goal = goal;
      if (Object.keys(updates).length) {
        await strapi.documents(CLIENT_UID).update({
          documentId: cl.documentId,
          data: updates as any,
        });
      }
    }

    return {
      customers_total: customers.length,
      internal_skipped,
      clients_total: clients.length,
      matched,
      sin_tarjeta: sin_tarjeta_names.length,
      sin_tarjeta_names,
      stampee_missing_mobile,
    };
  },

  /** Live customers+cards from the Stampee API (same shape `crosscheck` consumes). */
  async fetchCustomers(): Promise<StampeeCustomerApi[]> {
    return listCustomersWithCards();
  },

  /** The campaign to issue cards on: env override, else the single enabled campaign. */
  async resolveCampaignId(): Promise<string> {
    const envId = process.env.STAMPEE_CAMPAIGN_ID;
    if (envId) return envId;
    const campaigns = await listCampaigns();
    const enabled = campaigns.filter((c) => c.isEnabled !== false);
    if (enabled.length === 1) return enabled[0].id;
    if (campaigns.length === 1) return campaigns[0].id;
    throw new Error(
      `Cannot auto-pick a Stampee campaign (${campaigns.length} found, ${enabled.length} enabled) — set STAMPEE_CAMPAIGN_ID`,
    );
  },

  /**
   * Ensure every attended client (≥1 completed visit ⇒ last_visit_date set) has a card.
   * Phone is the sole dedup key. `dryRun` lists what *would* be created without writing.
   * Best-effort: per-client errors are collected, never thrown.
   */
  async ensureCards(
    customers: StampeeCustomerApi[],
    opts: { dryRun?: boolean } = {},
  ): Promise<any> {
    const dryRun = Boolean(opts.dryRun);
    const summary = {
      dry_run: dryRun,
      eligible: 0,
      already_carded: 0,
      created_customers: 0,
      issued_cards: 0,
      skipped_no_phone: 0,
      would_create: [] as Array<{ full_name: string; phone: string; has_customer: boolean }>,
      errors: [] as Array<{ client: string; error: string }>,
    };

    // Index Stampee customers by phone → does that phone already hold a card?
    const byPhone = new Map<string, { id: string; hasCard: boolean }>();
    for (const c of customers) {
      const l = last10(c.mobile);
      if (l) byPhone.set(l, { id: c.id, hasCard: (c.cards?.length ?? 0) > 0 });
    }

    const clients = (await strapi.documents(CLIENT_UID).findMany({
      filters: { last_visit_date: { $notNull: true } } as any,
      limit: 1000,
    })) as any[];
    summary.eligible = clients.length;

    let campaignId: string | null = null;

    for (const cl of clients) {
      const l = last10(cl.phone);
      if (!l) {
        summary.skipped_no_phone++;
        continue;
      }
      const match = byPhone.get(l);
      if (match?.hasCard) {
        summary.already_carded++;
        continue;
      }
      if (dryRun) {
        summary.would_create.push({
          full_name: cl.full_name,
          phone: cl.phone,
          has_customer: Boolean(match),
        });
        continue;
      }
      try {
        if (!campaignId) campaignId = await this.resolveCampaignId();
        let customerId = match?.id;
        if (!customerId) {
          const created = await createCustomer({
            name: cl.full_name || cl.phone,
            mobile: cl.phone,
            ...(cl.email ? { email: cl.email } : {}),
            status: 'Active',
          });
          customerId = created.id;
          summary.created_customers++;
        }
        const card = await issueCard({ customerId, campaignId });
        summary.issued_cards++;
        await strapi.documents(CLIENT_UID).update({
          documentId: cl.documentId,
          data: {
            stampee_card: 'matched',
            stampee_customer_id: customerId,
            stampee_card_unique_id: card.uniqueId,
          } as any,
        });
      } catch (err: any) {
        summary.errors.push({ client: cl.full_name || cl.phone, error: err?.message });
      }
    }
    return summary;
  },

  /** Count a client's completed (Asiste) visits — the source of truth for stamp count. */
  async completedVisitCount(clientDocumentId: string): Promise<number> {
    const visits = (await strapi.documents(VISIT_UID).findMany({
      filters: { client: { documentId: clientDocumentId }, status: 'completed' } as any,
      fields: ['id'] as any,
      limit: 1000,
    })) as any[];
    return visits.length;
  },

  /**
   * Per-visit stamping (plan §5.4). Reconciles each carded client's Stampee card so it holds
   * one stamp per completed visit. Idempotent across daily re-imports: `Client.stampee_stamped_count`
   * records how many visits we've already pushed, so only *new* visits add stamps. The first ever
   * stamp is logged as "Primera visita", the rest as "Visita recurrente".
   *
   * Stamps never exceed the campaign goal — when a card fills up we stop and leave it for manual
   * redemption. `stampee_stamped_count` only advances by stamps actually applied, so once Mariana
   * redeems and a fresh card appears, the remaining visits stamp onto it on the next run.
   * Best-effort: per-client errors are collected, never thrown.
   */
  async stampVisits(
    customers: StampeeCustomerApi[],
    opts: { dryRun?: boolean } = {},
  ): Promise<any> {
    const dryRun = Boolean(opts.dryRun);
    const summary = {
      dry_run: dryRun,
      eligible: 0,
      stamped_clients: 0,
      stamps_added: 0,
      already_current: 0,
      capped_at_goal: 0,
      skipped_no_active_card: 0,
      would_stamp: [] as Array<{ full_name: string; from: number; to: number; goal: number }>,
      errors: [] as Array<{ client: string; error: string }>,
    };

    // Campaign → stamp goal (the redemption target). Env override / fallback if the API omits it.
    const goalByCampaign = new Map<string, number>();
    try {
      for (const c of await listCampaigns()) {
        if (typeof c.totalStamps === 'number' && c.totalStamps > 0) goalByCampaign.set(c.id, c.totalStamps);
      }
    } catch {
      /* fall back to the env goal below */
    }
    const envGoal = Number(process.env.STAMPEE_STAMP_GOAL);
    const goalFor = (campaignId?: string | null): number =>
      goalByCampaign.get(campaignId ?? '') ?? (Number.isFinite(envGoal) && envGoal > 0 ? envGoal : Infinity);

    // Index Stampee customers by phone → their cards.
    const cardsByPhone = new Map<string, StampeeCard[]>();
    for (const c of customers) {
      const l = last10(c.mobile);
      if (l) cardsByPhone.set(l, c.cards ?? []);
    }

    const clients = (await strapi.documents(CLIENT_UID).findMany({
      filters: { last_visit_date: { $notNull: true } } as any,
      limit: 1000,
    })) as any[];
    summary.eligible = clients.length;

    for (const cl of clients) {
      try {
        const l = last10(cl.phone);
        if (!l) continue;

        const completed = await this.completedVisitCount(cl.documentId);
        const prevStamped = Number(cl.stampee_stamped_count ?? 0);
        const newStamps = completed - prevStamped;
        if (newStamps <= 0) {
          summary.already_current++;
          continue;
        }

        // Stamp the active (non-redeemed) card with the most progress, to fill it first.
        const active = (cardsByPhone.get(l) ?? [])
          .filter((cd) => (cd.status ?? 'Active') !== 'Redeemed')
          .sort((a, b) => (b.stamps ?? 0) - (a.stamps ?? 0));
        const card = active[0];
        if (!card) {
          summary.skipped_no_active_card++;
          continue;
        }

        const current = Number(card.stamps ?? 0);
        const goal = goalFor(card.campaignId);
        const capacity = goal - current;
        const applied = Math.max(0, Math.min(newStamps, capacity));
        if (applied <= 0) {
          // Card already at goal — waiting on manual redemption. Don't advance the counter.
          summary.capped_at_goal++;
          continue;
        }
        const target = current + applied;
        if (applied < newStamps) summary.capped_at_goal++;

        if (dryRun) {
          summary.would_stamp.push({
            full_name: cl.full_name || cl.phone,
            from: current,
            to: target,
            goal: Number.isFinite(goal) ? goal : 0,
          });
          continue;
        }

        // Authoritative count first, then best-effort audit entries (one per new visit).
        await patchCard(card.id, {
          stamps: target,
          ...(cl.last_visit_date ? { lastVisit: cl.last_visit_date } : {}),
        });
        const ts = Date.now();
        for (let i = 0; i < applied; i++) {
          const isFirstEver = prevStamped + i === 0;
          try {
            await addCardTransaction(card.id, {
              type: 'stamp_add',
              amount: 1,
              date: cl.last_visit_date ?? new Date(ts).toISOString().slice(0, 10),
              timestamp: ts,
              title: isFirstEver ? 'Primera visita' : 'Visita recurrente',
              remarks: 'Sincronizado desde AgendaPro (CRM)',
            });
          } catch (e: any) {
            strapi.log.warn(`[stampee] transaction log failed for ${cl.full_name}: ${e?.message}`);
          }
        }
        await strapi.documents(CLIENT_UID).update({
          documentId: cl.documentId,
          data: { stampee_stamped_count: prevStamped + applied } as any,
        });
        summary.stamped_clients++;
        summary.stamps_added += applied;
      } catch (err: any) {
        summary.errors.push({ client: cl.full_name || cl.phone, error: err?.message });
      }
    }
    return summary;
  },

  /**
   * Live sync entry point: fetch from Stampee → crosscheck → optionally ensure cards → optionally
   * stamp per visit. No-op (skipped) when the API key isn't configured, so the report feed never breaks.
   */
  async syncFromApi(
    opts: { autocreate?: boolean; autostamp?: boolean; dryRun?: boolean } = {},
  ): Promise<any> {
    if (!stampeeConfigured()) return { skipped: 'not_configured' };
    const customers = await this.fetchCustomers();
    const goal = await this.resolveStampGoal();
    const crosscheck = await this.crosscheck(customers, { goal });
    let autocreate: any = null;
    let stamping: any = null;
    if (opts.dryRun) {
      autocreate = await this.ensureCards(customers, { dryRun: true });
      stamping = await this.stampVisits(customers, { dryRun: true });
    } else {
      if (opts.autocreate) autocreate = await this.ensureCards(customers, { dryRun: false });
      if (opts.autostamp) {
        // Re-fetch if we just issued cards, so brand-new cards are visible to the stamper.
        const fresh = autocreate ? await this.fetchCustomers() : customers;
        stamping = await this.stampVisits(fresh, { dryRun: false });
      }
    }
    return { crosscheck, autocreate, stamping };
  },
});
