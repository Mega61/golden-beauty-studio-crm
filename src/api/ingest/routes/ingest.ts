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
  ],
};
