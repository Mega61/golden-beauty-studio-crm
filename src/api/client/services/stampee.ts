/**
 * Stampee fidelization cross-check (phone-only, plan §6). Reads Stampee customers,
 * matches their `mobile` against Strapi `Client.phone`, and stamps each client
 * `matched | sin_tarjeta`. Read-only against Stampee — we never write back there.
 */
import type { Core } from '@strapi/strapi';
import { normalizePhone } from '../../../winback/normalize';

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
});
