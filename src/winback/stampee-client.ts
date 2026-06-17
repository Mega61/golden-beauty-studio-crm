/**
 * Thin Stampee HTTP API client (API-key auth). Read customers+cards, list campaigns,
 * create customers, issue cards. Returns the unwrapped `data` and throws on any non-ok
 * envelope so callers can isolate failures. See .claude/handoff/stampee-api-doc.md.
 */
export interface StampeeCard {
  id: string;
  uniqueId: string;
  status?: string;
}
export interface StampeeCustomerApi {
  id: string;
  name: string;
  email?: string | null;
  mobile?: string | null;
  status?: string;
  cards?: StampeeCard[];
}
export interface StampeeCampaign {
  id: string;
  name: string;
  isEnabled?: boolean;
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
  const res = await fetch(`${c.base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${c.key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    const msg = json?.error?.message ?? json?.error?.code ?? `HTTP ${res.status}`;
    throw new Error(`Stampee ${init.method ?? 'GET'} ${path}: ${msg}`);
  }
  return json.data as T;
}

export function listCustomersWithCards(): Promise<StampeeCustomerApi[]> {
  return call<StampeeCustomerApi[]>('/customers?include=cards');
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
}): Promise<{ id: string; uniqueId: string }> {
  return call<{ id: string; uniqueId: string }>('/cards', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
