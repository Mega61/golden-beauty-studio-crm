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
