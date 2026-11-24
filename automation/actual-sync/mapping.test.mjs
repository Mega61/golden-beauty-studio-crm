// node --test automation/actual-sync/mapping.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bareNotesFor, fromPanel, isDeposit, isGiftCardSale, notesFor, toActualTxn } from './mapping.mjs';

const opts = { panelPayee: 'Golden Beauty Studio', category: 'cat-servicios' };

test('gift card sales are panel rows: panel payee, Servicios, agendapro-tx: imported_id', () => {
  const inc = {
    tx_id: 'bono:TR-7K3M-Q9XA',
    sale_id: null,
    client_name: 'Laura Gómez',
    service_name: 'Tarjeta regalo Consentida',
    paid_at: '2026-12-05',
    amount: 100000,
    tip: 0,
    method: 'transferencia',
  };
  assert.equal(fromPanel(inc), true);
  assert.equal(isGiftCardSale(inc), true);
  assert.deepEqual(toActualTxn(inc, opts), {
    date: '2026-12-05',
    amount: 10_000_000,
    payee_name: 'Golden Beauty Studio',
    imported_id: 'agendapro-tx:bono:TR-7K3M-Q9XA',
    category: 'cat-servicios',
    notes: 'Tarjeta regalo · Laura Gómez · transferencia',
    cleared: true,
  });
});

test('a void after sync is a negative panel movement with its own imported_id', () => {
  const inc = { tx_id: 'bono:TR-7K3M-Q9XA:adj1', client_name: 'Laura Gómez', paid_at: '2026-12-09', amount: -100000, tip: 0, method: 'efectivo' };
  const txn = toActualTxn(inc, opts);
  assert.equal(txn.amount, -10_000_000);
  assert.equal(txn.payee_name, 'Golden Beauty Studio');
  assert.equal(txn.imported_id, 'agendapro-tx:bono:TR-7K3M-Q9XA:adj1');
  assert.equal(txn.notes, 'Tarjeta regalo · Laura Gómez · efectivo');
});

test('gift card notes without a buyer name, and the bare form refreshNotes matches', () => {
  const inc = { tx_id: 'bono:TR-7K3M-Q9XA', method: 'efectivo' };
  assert.equal(notesFor(inc), 'Tarjeta regalo · efectivo');
  assert.equal(bareNotesFor({ ...inc, client_name: 'Ana' }), 'Tarjeta regalo · efectivo');
});

test('appointment payments and AgendaPro rows are unchanged', () => {
  const panel = { tx_id: 'ea-appt:812', client_name: 'Ana Ruiz', service_name: 'Semi manos', paid_at: '2026-11-10', amount: 60000, tip: 5000, method: 'efectivo' };
  const t = toActualTxn(panel, opts);
  assert.equal(t.payee_name, 'Golden Beauty Studio');
  assert.equal(t.amount, 6_500_000);
  assert.equal(t.imported_id, 'agendapro-tx:ea-appt:812');
  assert.equal(t.notes, 'Ana Ruiz · Semi manos · efectivo');
  assert.equal(isGiftCardSale(panel), false);

  const ap = { tx_id: '99812', sale_id: '1129', client_name: 'Monica Jaramillo', service_name: 'Tradicional pies', paid_at: '2026-10-01', amount: 45000, tip: 0, method: 'transferencia' };
  const a = toActualTxn(ap, opts);
  assert.equal(fromPanel(ap), false);
  assert.equal(a.payee_name, 'AgendaPro');
  assert.equal(a.imported_id, 'agendapro-tx:99812');
  assert.equal(a.notes, 'Monica Jaramillo · Tradicional pies · Venta 1129 · transferencia');
});

test('deposits are panel rows on the day they came in, with an appointment-style note', () => {
  const inc = {
    tx_id: 'abono:7',
    client_name: 'Ana Ruiz',
    service_name: 'Adelanto cita 2026-12-12',
    paid_at: '2026-11-23',
    amount: 50000,
    tip: 0,
    method: 'transferencia',
  };
  assert.equal(fromPanel(inc), true);
  assert.equal(isDeposit(inc), true);
  assert.equal(isGiftCardSale(inc), false);
  assert.deepEqual(toActualTxn(inc, opts), {
    date: '2026-11-23',
    amount: 5_000_000,
    payee_name: 'Golden Beauty Studio',
    imported_id: 'agendapro-tx:abono:7',
    category: 'cat-servicios',
    notes: 'Ana Ruiz · Adelanto cita 2026-12-12 · transferencia',
    cleared: true,
  });
  const refund = toActualTxn({ ...inc, tx_id: 'abono:7:adj1', amount: -20000, paid_at: '2026-12-01' }, opts);
  assert.equal(refund.amount, -2_000_000);
  assert.equal(refund.imported_id, 'agendapro-tx:abono:7:adj1');
});
