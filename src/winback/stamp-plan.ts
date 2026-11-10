/**
 * Pure stamp-reconciliation rules for the Stampee sync (no Strapi, no HTTP), so they can be
 * unit-tested with `node --test`.
 *
 * A card's stamps are visit stamps + gifted stamps. Gifted stamps (the campaign's welcome
 * `bonusStamps`, win-back `gift` and scratch-game `bonus` transactions) are never visits, so the
 * nightly sync must leave them alone: it only reconciles the VISIT part of the card. The split
 * mirrors Stampee's own `summarizeCard` (api/src/routes/lookup.ts), which shows the same numbers
 * to the panel.
 */

export interface PlanTx {
  type: string;
  amount?: number;
  timestamp?: number | string;
}

export interface PlanCard {
  id: string;
  status?: string;
  stamps?: number;
  campaignId?: string | null;
  templateSnapshot?: Record<string, unknown> | null;
  history?: PlanTx[];
}

export interface PlanCampaign {
  id: string;
  isEnabled?: boolean;
  totalStamps?: number;
  bonusStamps?: number;
}

const isRedeemed = (c: PlanCard) => (c.status ?? 'Active') === 'Redeemed';
const num = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : null;
};

/** Stamps needed to fill the card: snapshot first (what the client sees), then the campaign. */
export function cardGoal(card: PlanCard, campaign: PlanCampaign | undefined, envGoal?: number): number {
  const snap = num(card.templateSnapshot?.['totalStamps']);
  if (snap && snap > 0) return snap;
  if (campaign?.totalStamps && campaign.totalStamps > 0) return campaign.totalStamps;
  return envGoal && envGoal > 0 ? envGoal : Infinity;
}

/**
 * Stamps on this card that did not come from a visit. Welcome gift: snapshot, then the amount on
 * the `issued` entry, then the campaign setting (cards issued via the API carry neither), capped
 * below the goal like Stampee does. Plus every `gift` (win-back) and `bonus` (game) entry.
 */
export function giftedStamps(card: PlanCard, campaign: PlanCampaign | undefined, goal: number): number {
  const history = card.history ?? [];
  const issued = history.find((t) => t.type === 'issued');
  const welcomeRaw =
    num(card.templateSnapshot?.['bonusStamps']) ?? num(issued?.amount) ?? campaign?.bonusStamps ?? 0;
  const welcome = Math.max(0, Math.min(welcomeRaw, Number.isFinite(goal) ? Math.max(goal - 1, 0) : welcomeRaw));
  let extra = 0;
  for (const t of history) if (t.type === 'gift' || t.type === 'bonus') extra += Number(t.amount ?? 0);
  return welcome + extra;
}

/** When the card started: its earliest history entry (no history ⇒ treated as the oldest). */
const birth = (card: PlanCard): number => {
  let min = Infinity;
  for (const t of card.history ?? []) {
    const ts = Number(t.timestamp);
    if (Number.isFinite(ts) && ts < min) min = ts;
  }
  return Number.isFinite(min) ? min : 0;
};

/**
 * The card new visits land on: the NEWEST active card (a win-back card issued on top of an old one
 * takes over), ties broken by most stamps. Older active cards are left as they are.
 */
export function pickStampCard(cards: PlanCard[]): PlanCard | undefined {
  return cards
    .filter((c) => !isRedeemed(c))
    .sort((a, b) => birth(b) - birth(a) || (b.stamps ?? 0) - (a.stamps ?? 0))[0];
}

export interface StampPlan {
  card: PlanCard;
  goal: number;
  current: number;
  target: number;
  gifted: number;
  /** Visits already sitting on the client's other cards (redeemed or older active ones). */
  visitsElsewhere: number;
}

/**
 * Absolute target for the client's stamp card: completed visits not already on another card, plus
 * this card's gifted stamps, capped at the goal. A redeemed card cashed out `goal − its gifts`
 * visits; an older active card holds `stamps − its gifts` visits.
 */
export function planStamps(
  cards: PlanCard[],
  completedVisits: number,
  campaigns: PlanCampaign[],
  envGoal?: number,
): StampPlan | null {
  const card = pickStampCard(cards);
  if (!card) return null;
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const meta = (c: PlanCard) => {
    const campaign = byId.get(c.campaignId ?? '');
    const goal = cardGoal(c, campaign, envGoal);
    return { goal, gifted: giftedStamps(c, campaign, goal) };
  };

  let visitsElsewhere = 0;
  for (const other of cards) {
    if (other === card) continue;
    const { goal, gifted } = meta(other);
    const full = isRedeemed(other) && Number.isFinite(goal) ? goal : Number(other.stamps ?? 0);
    visitsElsewhere += Math.max(0, full - gifted);
  }

  const { goal, gifted } = meta(card);
  const current = Number(card.stamps ?? 0);
  const target = Math.max(0, Math.min(completedVisits - visitsElsewhere + gifted, goal));
  return { card, goal, current, target, gifted, visitsElsewhere };
}

/**
 * The campaign the CRM issues new clients' cards on. Env pin first; else the only enabled one;
 * else, when a second campaign (e.g. a win-back one) is enabled, the enabled campaign that already
 * holds the most cards, so turning on a new campaign never stops the normal card flow.
 */
export function pickMainCampaign(
  campaigns: PlanCampaign[],
  envId: string | undefined,
  cardCountByCampaign: Map<string, number>,
): PlanCampaign | null {
  if (envId) return campaigns.find((c) => c.id === envId) ?? { id: envId };
  const enabled = campaigns.filter((c) => c.isEnabled !== false);
  if (enabled.length === 1) return enabled[0];
  if (!enabled.length) return campaigns.length === 1 ? campaigns[0] : null;
  const ranked = [...enabled].sort(
    (a, b) => (cardCountByCampaign.get(b.id) ?? 0) - (cardCountByCampaign.get(a.id) ?? 0),
  );
  const top = cardCountByCampaign.get(ranked[0].id) ?? 0;
  const second = cardCountByCampaign.get(ranked[1].id) ?? 0;
  return top > second ? ranked[0] : null;
}
