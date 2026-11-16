// node --test src/winback/panel-payments.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGiftCardTxId, isPanelTxId, validatePanelPayments } from './panel-payments.ts';

const row = (tx_id: string, extra: Record<string, unknown> = {}) => ({
  tx_id,
  paid_at: '2026-12-05',
  amount: 100000,
  tip: 0,
  method: 'transferencia',
  ...extra,
});

test('appointment payments keep working: ea-appt:<id>, split and adjustments', () => {
  const res = validatePanelPayments([
    row('ea-appt:812'),
    row('ea-appt:813:efectivo', { method: 'efectivo' }),
    row('ea-appt:812:adj1', { amount: -20000 }),
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.rows.length, 3);
});

test('gift card sales are accepted: bono:<code> and bono:<code>:adj<n>', () => {
  const res = validatePanelPayments([
    row('bono:TR-7K3M-Q9XA', { client_name: ' Laura Gómez ', service_name: 'Tarjeta regalo Detalle' }),
    row('bono:TR-7K3M-Q9XA:adj1', { amount: -100000 }),
    row('bono:TR-0000-ZZZZ:adj12', { method: 'efectivo' }),
  ]);
  assert.ok(res.ok, !res.ok ? res.error : '');
  assert.deepEqual(res.rows[0], {
    tx_id: 'bono:TR-7K3M-Q9XA',
    paid_at: '2026-12-05',
    amount: 100000,
    tip: 0,
    method: 'transferencia',
    client_name: 'Laura Gómez',
    service_name: 'Tarjeta regalo Detalle',
  });
  assert.equal(res.rows[1].amount, -100000);
});

test('malformed gift card ids reject the whole batch', () => {
  for (const bad of [
    'bono:',
    'bono:TR-7K3M',
    'bono:tr-7k3m-q9xa',
    'bono:GB-7K3M-Q9XA',
    'bono:TR-7K3M-Q9XA:adj0',
    'bono:TR-7K3M-Q9XA:adj',
    'bono:TR-7K3M-Q9XA:efectivo',
    'bono:TR-7K3M-Q9XA-extra',
  ]) {
    const res = validatePanelPayments([row('ea-appt:1'), row(bad)]);
    assert.equal(res.ok, false, bad);
    assert.match(!res.ok ? res.error : '', /payments\[1\]\.tx_id/);
  }
});

test('other prefixes and AgendaPro numeric ids are still refused', () => {
  for (const bad of ['ea-appt:', '12345', 'agendapro-tx:1', 'BONO:TR-7K3M-Q9XA', '']) {
    assert.equal(validatePanelPayments([row(bad)]).ok, false, bad);
  }
});

test('a repeated gift card id in one batch is refused', () => {
  const res = validatePanelPayments([row('bono:TR-7K3M-Q9XA'), row(' bono:TR-7K3M-Q9XA ')]);
  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.error : '', /repeated/);
});

test('gift card rows follow the same method rule: bono is never a pushed method', () => {
  const res = validatePanelPayments([row('bono:TR-7K3M-Q9XA', { method: 'bono' })]);
  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.error : '', /method/);
});

test('isPanelTxId / isGiftCardTxId', () => {
  assert.equal(isPanelTxId('ea-appt:5'), true);
  assert.equal(isPanelTxId('bono:TR-AB12-CD34'), true);
  assert.equal(isPanelTxId('bono:TR-AB12-CD34:adj2'), true);
  assert.equal(isPanelTxId('9981'), false);
  assert.equal(isGiftCardTxId('bono:TR-AB12-CD34:adj1'), true);
  assert.equal(isGiftCardTxId('ea-appt:5'), false);
  assert.equal(isGiftCardTxId(null), false);
});
