// node --test src/winback/stamp-plan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { giftedStamps, pickMainCampaign, pickStampCard, planStamps } from './stamp-plan.ts';

const MAIN = { id: 'main', isEnabled: true, totalStamps: 8, bonusStamps: 0 };
const WINBACK = { id: 'winback', isEnabled: true, totalStamps: 8, bonusStamps: 3 };
const campaigns = [MAIN, WINBACK];

const tx = (type: string, amount: number, timestamp: number) => ({ type, amount, timestamp });

test('a plain card keeps the old rule: stamps == completed visits, capped at the goal', () => {
  const card = { id: 'a', stamps: 2, campaignId: 'main', history: [tx('issued', 0, 1), tx('stamp_add', 1, 2)] };
  assert.equal(planStamps([card], 3, campaigns)!.target, 3);
  assert.equal(planStamps([card], 12, campaigns)!.target, 8);
  assert.equal(planStamps([card], 0, campaigns)!.target, 0);
});

test('win-back gift stamps survive the nightly sync', () => {
  const card = { id: 'a', stamps: 5, campaignId: 'main', history: [tx('stamp_add', 1, 1), tx('gift', 2, 5)] };
  const plan = planStamps([card], 3, campaigns)!;
  assert.equal(plan.gifted, 2);
  assert.equal(plan.target, 5); // unchanged: 3 visits + 2 gifted
});

test('game bonus stamps are not visits either', () => {
  const card = { id: 'a', stamps: 2, campaignId: 'main', history: [tx('stamp_add', 1, 1), tx('bonus', 1, 5)] };
  assert.equal(planStamps([card], 1, campaigns)!.target, 2);
});

test('a new win-back card takes the next visits and keeps its welcome stamps', () => {
  const old = { id: 'old', stamps: 4, campaignId: 'main', history: [tx('issued', 0, 100), tx('stamp_add', 1, 101)] };
  const fresh = { id: 'new', stamps: 3, campaignId: 'winback', history: [tx('issued', 3, 900)] };
  // Right after issuing: 4 visits, all on the old card → the new one stays at its 3 gifted stamps.
  let plan = planStamps([old, fresh], 4, campaigns)!;
  assert.equal(plan.card.id, 'new');
  assert.equal(plan.visitsElsewhere, 4);
  assert.equal(plan.target, 3);
  // She comes back: the 5th visit lands on the new card.
  plan = planStamps([old, fresh], 5, campaigns)!;
  assert.equal(plan.target, 4);
});

test('welcome gift falls back to the campaign when the card has no issued entry', () => {
  const card = { id: 'n', stamps: 3, campaignId: 'winback', history: [] };
  assert.equal(giftedStamps(card, WINBACK, 8), 3);
  assert.equal(planStamps([card], 0, campaigns)!.target, 3);
});

test('a redeemed card cashed out goal minus its gifts', () => {
  const redeemed = { id: 'r', status: 'Redeemed', stamps: 8, campaignId: 'winback', history: [tx('issued', 3, 1)] };
  const next = { id: 'n', stamps: 0, campaignId: 'main', history: [tx('issued', 0, 50)] };
  // 5 visits filled the win-back card (3 gifted + 5), one more visit since.
  assert.equal(planStamps([redeemed, next], 6, campaigns)!.target, 1);
});

test('two redeemed plain cards behave like the old goal × redeemed baseline', () => {
  const r1 = { id: 'r1', status: 'Redeemed', stamps: 8, campaignId: 'main', history: [tx('stamp_add', 1, 1)] };
  const r2 = { id: 'r2', status: 'Redeemed', stamps: 8, campaignId: 'main', history: [tx('stamp_add', 1, 2)] };
  const cur = { id: 'c', stamps: 0, campaignId: 'main', history: [tx('issued', 0, 3)] };
  assert.equal(planStamps([r1, r2, cur], 19, campaigns)!.target, 3);
});

test('newest active card wins; a card with no history counts as oldest', () => {
  const a = { id: 'a', stamps: 6, history: [tx('stamp_add', 1, 10)] };
  const b = { id: 'b', stamps: 1, history: [tx('issued', 0, 20)] };
  const c = { id: 'c', stamps: 9, history: [] };
  assert.equal(pickStampCard([a, b, c])!.id, 'b');
  assert.equal(pickStampCard([{ ...a, status: 'Redeemed' }])?.id, undefined);
});

test('main campaign: env pin, single enabled, then the one holding most cards', () => {
  const counts = new Map([['main', 111], ['winback', 4]]);
  assert.equal(pickMainCampaign(campaigns, 'winback', counts)!.id, 'winback');
  assert.equal(pickMainCampaign([MAIN, { ...WINBACK, isEnabled: false }], undefined, counts)!.id, 'main');
  assert.equal(pickMainCampaign(campaigns, undefined, counts)!.id, 'main');
  assert.equal(pickMainCampaign(campaigns, undefined, new Map())?.id, undefined);
});
