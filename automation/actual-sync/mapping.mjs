/**
 * Pure helpers of the Actual sync (no I/O), split out of sync.mjs so they can be tested
 * with `node --test` without the Actual API or a Strapi.
 */

// Rows the admin panel wrote (see sync.mjs's header). Everything else is the AgendaPro
// scrape. `ea-appt:` = an appointment's payment; `bono:` = a gift card sale (or its
// `:adj<n>` void), money that came in without a visit.
export const isGiftCardSale = (inc) => String(inc.tx_id ?? '').startsWith('bono:');
export const fromPanel = (inc) =>
  String(inc.tx_id ?? '').startsWith('ea-appt:') || isGiftCardSale(inc);

// Same as the CRM's normalizePhone: the last 10 digits, as +57XXXXXXXXXX.
export const normPhone = (s) => {
  const digits = String(s ?? '').replace(/\D/g, '');
  return digits.length < 10 ? null : `+57${digits.slice(-10)}`;
};

// The notes this job writes. Order matters to people reading them: who, what, then the ids.
// A gift card sale reads "Tarjeta regalo · <buyer> · <method>".
export const notesFor = (inc) =>
  (isGiftCardSale(inc)
    ? ['Tarjeta regalo', inc.client_name, inc.method]
    : [inc.client_name, inc.service_name, inc.sale_id ? `Venta ${inc.sale_id}` : null, inc.method]
  )
    .filter(Boolean)
    .join(' · ');
// What the notes looked like before the names existed — the only text refreshNotes replaces.
export const bareNotesFor = (inc) => notesFor({ ...inc, client_name: null, service_name: null });

/** The Actual transaction for one income. imported_id keeps `agendapro-tx:` on purpose. */
export const toActualTxn = (inc, { panelPayee, category }) => ({
  date: inc.paid_at,
  amount: Math.round((Number(inc.amount) + Number(inc.tip || 0)) * 100), // COP -> minor, inflow
  payee_name: fromPanel(inc) ? panelPayee : 'AgendaPro',
  imported_id: `agendapro-tx:${inc.tx_id}`,
  category,
  notes: notesFor(inc),
  cleared: true,
});
