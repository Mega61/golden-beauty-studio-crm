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
  type StampeeCustomerApi,
} from '../../../winback/stampee-client';

const CLIENT_UID = 'api::client.client';
const INTERNAL_EMAIL = '@goldenbeautystudio';

export interface StampeeCustomer {
  id: string;
  name: string;
  email?: string | null;
  mobile?: string | null;
  status?: string;
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

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async crosscheck(customers: StampeeCustomer[]): Promise<CrosscheckSummary> {
    // 1. Drop internal staff/owner Stampee logins.
    const external = customers.filter((c) => !String(c.email ?? '').includes(INTERNAL_EMAIL));
    const internal_skipped = customers.length - external.length;

    // 2. Index card phones; collect customers with no usable mobile.
    const cardPhones = new Set<string>();
    const stampee_missing_mobile: string[] = [];
    for (const c of external) {
      const l = last10(c.mobile);
      if (l) cardPhones.add(l);
      else stampee_missing_mobile.push(c.name);
    }

    // 3. Stamp each Strapi client matched / sin_tarjeta.
    const clients = (await strapi.documents(CLIENT_UID).findMany({ limit: 1000 })) as any[];
    let matched = 0;
    const sin_tarjeta_names: string[] = [];

    for (const cl of clients) {
      const l = last10(cl.phone);
      const status: 'matched' | 'sin_tarjeta' =
        l && cardPhones.has(l) ? 'matched' : 'sin_tarjeta';
      if (status === 'matched') matched++;
      else sin_tarjeta_names.push(cl.full_name || cl.phone);

      if (cl.stampee_card !== status) {
        await strapi.documents(CLIENT_UID).update({
          documentId: cl.documentId,
          data: { stampee_card: status } as any,
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

  /**
   * Live sync entry point: fetch from Stampee → crosscheck → optionally ensure cards.
   * No-op (skipped) when the API key isn't configured, so the report feed never breaks.
   */
  async syncFromApi(opts: { autocreate?: boolean; dryRun?: boolean } = {}): Promise<any> {
    if (!stampeeConfigured()) return { skipped: 'not_configured' };
    const customers = await this.fetchCustomers();
    const crosscheck = await this.crosscheck(customers);
    let autocreate: any = null;
    if (opts.dryRun) autocreate = await this.ensureCards(customers, { dryRun: true });
    else if (opts.autocreate) autocreate = await this.ensureCards(customers, { dryRun: false });
    return { crosscheck, autocreate };
  },
});
