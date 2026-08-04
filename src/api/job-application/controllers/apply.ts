/**
 * Public job-application intake. `POST /api/job-applications/apply`.
 *
 * Auth is a shared-secret header (`x-careers-secret` == env CAREERS_SHARED_SECRET),
 * exactly like the AgendaPro ingest routes — the caller is the landing's
 * /api/postulaciones route handler, running server-side on Vercel, so the secret
 * never reaches a browser. This is why the Public role needs no permission on the
 * job-application content type: the browser never talks to Strapi directly and
 * cannot upload to the Media Library.
 *
 * Multipart body: field `cv` carries the file, the rest are plain text fields.
 * Every failure mode gets its own status code so the form can explain itself:
 *   400 validation · 415 file_type · 413 file_too_large · 429 rate_limited.
 */
const SECRET_HEADER = 'x-careers-secret';
const IP_HASH_HEADER = 'x-applicant-ip-hash';

function secretOk(ctx: any): boolean {
  const expected = process.env.CAREERS_SHARED_SECRET;
  const got = ctx.request.headers[SECRET_HEADER];
  return Boolean(expected) && typeof got === 'string' && got === expected;
}

export default {
  async submit(ctx: any) {
    if (!secretOk(ctx)) return ctx.unauthorized('Invalid careers secret.');

    const files = (ctx.request.files ?? {}) as Record<string, any>;
    const file = files.cv ?? Object.values(files)[0] ?? null;
    // Koa's body parser hands back an array when the field repeats.
    const cv = Array.isArray(file) ? file[0] : file;

    const ipHashRaw = ctx.request.headers[IP_HASH_HEADER];
    const ipHash = typeof ipHashRaw === 'string' ? ipHashRaw.slice(0, 64) : null;

    let result: any;
    try {
      result = await strapi.service('api::job-application.apply').submit({
        fields: ctx.request.body ?? {},
        file: cv,
        ipHash,
      });
    } catch (err: any) {
      // Upload/DB blew up. Log loud, answer vague — the applicant sees the
      // form's "try WhatsApp instead" fallback, not a stack trace.
      strapi.log.error(`[careers] submission failed: ${err?.message}`);
      ctx.status = 500;
      ctx.body = { ok: false, reason: 'server_error' };
      return;
    }

    if (result.ok) {
      ctx.status = 201;
      ctx.body = { ok: true, documentId: result.documentId };
      return;
    }

    switch (result.reason) {
      case 'validation':
        ctx.status = 400;
        ctx.body = { ok: false, reason: 'validation', fields: result.fields };
        return;
      case 'file_missing':
        ctx.status = 400;
        ctx.body = { ok: false, reason: 'file_missing' };
        return;
      case 'file_too_large':
        ctx.status = 413;
        ctx.body = { ok: false, reason: 'file_too_large', maxBytes: result.maxBytes };
        return;
      case 'file_type':
        ctx.status = 415;
        ctx.body = { ok: false, reason: 'file_type' };
        return;
      case 'rate_limited':
        ctx.status = 429;
        ctx.body = { ok: false, reason: 'rate_limited' };
        return;
      default:
        ctx.status = 400;
        ctx.body = { ok: false, reason: 'bad_request' };
    }
  },
};
