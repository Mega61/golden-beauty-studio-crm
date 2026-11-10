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
  type StampeeCampaign,
} from '../../../winback/stampee-client';
import { cardGoal, pickMainCampaign, pickStampCard, planStamps } from '../../../winback/stamp-plan';

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

const envStampGoal = (): number | undefined => {
  const n = Number(process.env.STAMPEE_STAMP_GOAL);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** How many cards each campaign holds — picks the main campaign once a second one is enabled. */
const cardCounts = (customers: StampeeCustomerApi[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const c of customers)
    for (const cd of c.cards ?? [])
      if (cd.campaignId) counts.set(cd.campaignId, (counts.get(cd.campaignId) ?? 0) + 1);
  return counts;
};

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * The campaign stamp goal (e.g. 8), preferring the live campaign's `totalStamps` and
   * falling back to STAMPEE_STAMP_GOAL. Used both to display "n/goal" and to cap stamping.
   */
  async resolveStampGoal(customers: StampeeCustomerApi[] = []): Promise<number | null> {
    try {
      const campaigns = await listCampaigns();
      const pick = pickMainCampaign(campaigns, process.env.STAMPEE_CAMPAIGN_ID, cardCounts(customers));
      if (pick && typeof pick.totalStamps === 'number' && pick.totalStamps > 0) return pick.totalStamps;
    } catch {
      /* fall back to env */
    }
    return envStampGoal() ?? null;
  },

  async crosscheck(
    customers: StampeeCustomer[],
    opts: { goal?: number | null; campaigns?: StampeeCampaign[] } = {},
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
    const campaignById = new Map((opts.campaigns ?? []).map((c) => [c.id, c]));
    let matched = 0;
    const sin_tarjeta_names: string[] = [];

    for (const cl of clients) {
      const l = last10(cl.phone);
      const cust = l ? byPhone.get(l) : undefined;
      const status: 'matched' | 'sin_tarjeta' = cust ? 'matched' : 'sin_tarjeta';
      if (status === 'matched') matched++;
      else sin_tarjeta_names.push(cl.full_name || cl.phone);

      // Live stamps from the card visits land on (null when matched-but-no-card, or no match at all).
      const card = cust ? pickStampCard(cust.cards ?? []) : undefined;
      const stamps = card ? Number(card.stamps ?? 0) : null;
      // That card's own goal (a win-back campaign may differ), else the main campaign's.
      const cg = card ? cardGoal(card, campaignById.get(card.campaignId ?? ''), opts.goal ?? undefined) : NaN;
      const goal = Number.isFinite(cg) ? cg : (opts.goal ?? null);

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

  /**
   * The campaign to issue new clients' cards on: env override, else the single enabled campaign,
   * else the enabled campaign holding the most cards (so enabling a win-back campaign doesn't stop
   * the normal flow). Throws only when that's still ambiguous.
   */
  async resolveCampaignId(customers: StampeeCustomerApi[] = []): Promise<string> {
    const campaigns = process.env.STAMPEE_CAMPAIGN_ID ? [] : await listCampaigns();
    const pick = pickMainCampaign(campaigns, process.env.STAMPEE_CAMPAIGN_ID, cardCounts(customers));
    if (pick) return pick.id;
    const enabled = campaigns.filter((c) => c.isEnabled !== false);
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
        if (!campaignId) campaignId = await this.resolveCampaignId(customers);
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
   * Per-visit stamping (plan §5.4). Reconciles each carded client's Stampee card so its stamp
   * count EQUALS their completed visits not already on another card, plus the card's gifted stamps
   * (welcome, win-back gift, game bonus), capped at the goal — rules in `winback/stamp-plan.ts`.
   * The count is ABSOLUTE, not additive: re-running an import leaves an already-correct card
   * untouched, and it repairs cards an earlier additive version double-counted. Visits land on the
   * newest active card, so a win-back card issued on top of an old one takes over. Stamp #1 (ever)
   * logs "Primera visita", the rest "Visita recurrente"; a downward repair logs one "Corrección de
   * sellos". Redeemed cards are never stamped.
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
      stamps_corrected: 0,
      unchanged: 0,
      skipped_no_active_card: 0,
      would_stamp: [] as Array<{ full_name: string; from: number; to: number; goal: number }>,
      errors: [] as Array<{ client: string; error: string }>,
    };

    // Campaigns carry each card's goal and welcome gift. Env goal is the fallback if the API fails.
    let campaigns: StampeeCampaign[] = [];
    try {
      campaigns = await listCampaigns();
    } catch {
      /* fall back to the env goal */
    }

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

        const cards = cardsByPhone.get(l) ?? [];
        if (!pickStampCard(cards)) {
          summary.skipped_no_active_card++;
          continue;
        }

        const completed = await this.completedVisitCount(cl.documentId);
        const plan = planStamps(cards, completed, campaigns, envStampGoal())!;
        const card = plan.card as StampeeCard;
        const { goal, current, target } = plan;
        if (target === current) {
          summary.unchanged++;
          continue;
        }

        if (dryRun) {
          summary.would_stamp.push({
            full_name: cl.full_name || cl.phone,
            from: current,
            to: target,
            goal: Number.isFinite(goal) ? goal : 0,
          });
          continue;
        }

        // Set the authoritative count, then best-effort audit entries.
        await patchCard(card.id, {
          stamps: target,
          ...(cl.last_visit_date ? { lastVisit: cl.last_visit_date } : {}),
        });
        const ts = Date.now();
        const stampDate = cl.last_visit_date ?? new Date(ts).toISOString().slice(0, 10);
        if (target > current) {
          // One entry per newly-added stamp; the client's very first visit is "Primera visita".
          for (let p = current + 1; p <= target; p++) {
            const visitNo = plan.visitsElsewhere + p - plan.gifted;
            try {
              await addCardTransaction(card.id, {
                type: 'stamp_add',
                amount: 1,
                date: stampDate,
                timestamp: ts,
                title: visitNo === 1 ? 'Primera visita' : 'Visita recurrente',
                remarks: 'Sincronizado desde AgendaPro (CRM)',
              });
            } catch (e: any) {
              strapi.log.warn(`[stampee] transaction log failed for ${cl.full_name}: ${e?.message}`);
            }
          }
          summary.stamps_added += target - current;
        } else {
          // Downward repair (e.g. undoing an earlier double-count).
          try {
            await addCardTransaction(card.id, {
              type: 'stamp_remove',
              amount: current - target,
              date: stampDate,
              timestamp: ts,
              title: 'Corrección de sellos',
              remarks: 'Reconciliado con visitas reales (CRM)',
            });
          } catch (e: any) {
            strapi.log.warn(`[stampee] transaction log failed for ${cl.full_name}: ${e?.message}`);
          }
          summary.stamps_corrected += current - target;
        }

        await strapi.documents(CLIENT_UID).update({
          documentId: cl.documentId,
          data: { stampee_stamped_count: completed } as any,
        });
        summary.stamped_clients++;
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
    const goal = await this.resolveStampGoal(customers);
    const campaigns = await listCampaigns().catch(() => [] as StampeeCampaign[]);
    const crosscheck = await this.crosscheck(customers, { goal, campaigns });
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
