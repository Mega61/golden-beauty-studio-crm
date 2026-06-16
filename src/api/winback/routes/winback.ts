/**
 * Custom win-back routes. Authenticated (no `auth: false`) — clients carry PII, so the
 * caller needs an API token / permitted role. See plan §1.6.
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/winback/due',
      handler: 'winback.due',
      config: {
        policies: [],
      },
    },
  ],
};
