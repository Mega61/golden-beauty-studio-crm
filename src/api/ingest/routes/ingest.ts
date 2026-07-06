/**
 * AgendaPro intake routes. `auth: false` disables users-permissions auth — these are
 * gated by the shared-secret header checked in the controller (plan §2.3 / §2.5).
 */
export default {
  routes: [
    {
      method: 'POST',
      path: '/ingest/agendapro-report',
      handler: 'ingest.agendaproReport',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/ingest/agendapro',
      handler: 'ingest.agendapro',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/ingest/agendapro-transactions',
      handler: 'ingest.agendaproTransactions',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/ingest/agendapro-incomes',
      handler: 'ingest.agendaproIncomes',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/ingest/agendapro-incomes/mark-synced',
      handler: 'ingest.agendaproIncomesMarkSynced',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/ingest/stampee',
      handler: 'ingest.stampee',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/ingest/stampee-sync',
      handler: 'ingest.stampeeSync',
      config: { auth: false },
    },
  ],
};
