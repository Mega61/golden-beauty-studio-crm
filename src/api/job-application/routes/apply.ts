/**
 * Public intake route for "Trabaja con nosotros". `auth: false` turns off
 * users-permissions auth — the gate is the shared-secret header checked in
 * controllers/apply.ts, the same pattern the AgendaPro ingest routes use.
 *
 * Kept in its own route file so the core CRUD router (routes/job-application.ts)
 * stays untouched and admin-only.
 */
export default {
  routes: [
    {
      method: 'POST',
      path: '/job-applications/apply',
      handler: 'apply.submit',
      config: { auth: false },
    },
  ],
};
