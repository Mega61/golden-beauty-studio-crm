/**
 * Thin Stampee HTTP API client (API-key auth). Read customers+cards, list campaigns,
 * create customers, issue cards. Returns the unwrapped `data` and throws on any non-ok
 * envelope so callers can isolate failures. See .claude/handoff/stampee-api-doc.md.
 */
export interface StampeeCard {
  id: string;
  uniqueId: string;
  status?: string;
  /** Current stamp count and the campaign goal/linkage — present on `?include=cards`. */
  stamps?: number;
  lastVisit?: string | null;
  campaignId?: string | null;
  templateSnapshot?: Record<string, unknown> | null;
  /** Card transactions (`?include=cards,transactions`): tells gifted stamps from visit stamps. */
  history?: Array<{ type: string; amount?: number; timestamp?: number | string }>;
}
export interface StampeeCustomerApi {
  id: string;
  name: string;
  email?: string | null;
  mobile?: string | null;
  status?: string;
  /** The customer's permanent public link id (Stampee 0018); absent on older Stampee. */
  publicId?: string;
  cards?: StampeeCard[];
}
export interface StampeeCampaign {
  id: string;
  name: string;
  isEnabled?: boolean;
  /** Stamps required to complete the card (the redemption goal). */
  totalStamps?: number;
  /** Stamps a new card on this campaign starts with (welcome gift). */
  bonusStamps?: number;
}

function cfg(): { base: string; key: string } | null {
  const base = process.env.STAMPEE_API_URL?.replace(/\/+$/, '');
  const key = process.env.STAMPEE_API_KEY;
  return base && key ? { base, key } : null;
}

export function stampeeConfigured(): boolean {
  return cfg() !== null;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const c = cfg();
  if (!c) throw new Error('Stampee API not configured (STAMPEE_API_URL / STAMPEE_API_KEY)');
  const method = init.method ?? 'GET';
  const res = await fetch(`${c.base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${c.key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const msg = json?.error?.message ?? json?.error?.code ?? `HTTP ${res.status}`;
    throw new Error(`Stampee ${method} ${path}: ${msg} :: ${text.slice(0, 300)}`);
  }
  if (json == null) {
    throw new Error(`Stampee ${method} ${path}: non-JSON body :: ${text.slice(0, 300)}`);
  }
  // Accept either the documented `{ ok, data }` envelope or a raw body (array/object).
  if (typeof json === 'object' && !Array.isArray(json) && 'ok' in json) {
    if (!json.ok) {
      const msg = json.error?.message ?? json.error?.code ?? 'not ok';
      throw new Error(`Stampee ${method} ${path}: ${msg}`);
    }
    return json.data as T;
  }
  return json as T;
}

export function listCustomersWithCards(): Promise<StampeeCustomerApi[]> {
  return call<StampeeCustomerApi[]>('/customers?include=cards,transactions');
}

export function listCampaigns(): Promise<StampeeCampaign[]> {
  return call<StampeeCampaign[]>('/campaigns');
}

export function createCustomer(body: {
  name: string;
  mobile?: string;
  email?: string;
  status?: 'Active' | 'Inactive';
}): Promise<{ id: string }> {
  return call<{ id: string }>('/customers', { method: 'POST', body: JSON.stringify(body) });
}

export function issueCard(body: {
  customerId: string;
  campaignId: string;
}): Promise<{ id: string; uniqueId: string; customerPublicId?: string }> {
  return call<{ id: string; uniqueId: string; customerPublicId?: string }>('/cards', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Set a card's authoritative stamp count (and last-visit date). PATCH /cards/:id. */
export function patchCard(
  cardId: string,
  body: { stamps?: number; lastVisit?: string; status?: 'Active' | 'Redeemed'; completedDate?: string },
): Promise<StampeeCard> {
  return call<StampeeCard>(`/cards/${cardId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** Append an audit entry to a card's history (does not itself change the stamp count). */
export function addCardTransaction(
  cardId: string,
  body: {
    type: 'stamp_add' | 'stamp_remove' | 'redeem' | 'issued';
    amount: number;
    date: string;
    timestamp: number;
    title: string;
    remarks?: string;
  },
): Promise<any> {
  return call<any>(`/cards/${cardId}/transactions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** An advent-calendar gift as the studio sees it (Stampee GET /advent/rewards). */
export interface StampeeAdventReward {
  customerId: string;
  kind: string;
  status: string;
  validFrom: string | null;
  validTo: string | null;
}

/** Available advent gifts of every customer. Throws on a Stampee without the calendar (404). */
export function listAvailableAdventRewards(): Promise<{ rewards: StampeeAdventReward[] }> {
  return call<{ rewards: StampeeAdventReward[] }>('/advent/rewards?status=available');
}

/** January double stamp for one qualifying visit. Idempotent on visitRef. */
export function applyAdventDoubleStamp(body: {
  customerId: string;
  visitRef: string;
  visitDate: string;
}): Promise<{ added: number; reason?: string }> {
  return call<{ added: number; reason?: string }>('/advent/double-stamps', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
