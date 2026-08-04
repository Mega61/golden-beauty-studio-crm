/**
 * Media Library home for the CVs that arrive with a job application.
 *
 * Why a dedicated folder:
 *   1. Hygiene — hoja-de-vida PDFs never mix into the marketing media the owner
 *      browses when picking a lookbook photo.
 *   2. No watermarking — a fair share of applicants photograph their resume with
 *      their phone instead of attaching a PDF, and the upload watermark hook
 *      would otherwise bake the gold wordmark onto that image. The hook skips
 *      this folder unconditionally (see src/extensions/upload-watermark).
 *
 * The folder is created idempotently at bootstrap; if creation ever fails the
 * apply flow still works (the CV lands in the Media Library root) — a misfiled
 * CV is much better than a rejected applicant.
 */
import type { Core } from '@strapi/strapi';

const FOLDER_MODEL_UID = 'plugin::upload.folder';
const JOB_ROLE_UID = 'api::job-role.job-role';

/** Media Library folder name. Referenced by the watermark hook — keep in sync. */
export const CAREERS_FOLDER_NAME = 'Postulaciones';

let cachedId: number | null = null;

async function findFolderId(strapi: Core.Strapi): Promise<number | null> {
  const folder = await strapi.db
    .query(FOLDER_MODEL_UID)
    .findOne({ where: { name: CAREERS_FOLDER_NAME } });
  return folder?.id ?? null;
}

/**
 * Ensures the CV folder exists. Idempotent — safe on every boot. Returns the
 * folder id (also memoized for `getCareersFolderId`).
 */
export async function ensureCareersFolder(strapi: Core.Strapi): Promise<number | null> {
  try {
    const existing = await findFolderId(strapi);
    if (existing) {
      cachedId = existing;
      return existing;
    }

    const created = await strapi
      .plugin('upload')
      .service('folder')
      .create({ name: CAREERS_FOLDER_NAME, parent: null });
    cachedId = created?.id ?? null;
    strapi.log.info(`[careers] created Media Library folder "${CAREERS_FOLDER_NAME}"`);
    return cachedId;
  } catch (err: any) {
    strapi.log.warn(
      `[careers] could not ensure the "${CAREERS_FOLDER_NAME}" folder (CVs will land in the Media Library root): ${err?.message}`,
    );
    return null;
  }
}

/**
 * Folder id for an incoming CV upload. Memoized after the first hit; falls back
 * to a live lookup (and finally to `null` = root) so a submission never fails
 * just because the folder is missing.
 */
export async function getCareersFolderId(strapi: Core.Strapi): Promise<number | null> {
  if (cachedId) return cachedId;
  try {
    cachedId = await findFolderId(strapi);
  } catch {
    cachedId = null;
  }
  return cachedId;
}

/* ── cargos (job roles) ───────────────────────────────────────────────────── */

/**
 * First-run seed for the cargos offered in the careers form. These are only
 * starting points: the owner renames, reorders, deactivates or adds her own in
 * the admin, and the form on the web follows — nothing here is hard-coded on the
 * landing side.
 *
 * Idempotent and keyed by slug, like the lookbook/pricing seeds: a label edited
 * in the admin is never overwritten on the next boot, and a role the owner
 * deliberately deleted does NOT come back (we only seed when the table is
 * empty).
 */
const DEFAULT_ROLES: Array<{ slug: string; label_es: string; label_en: string }> = [
  { slug: 'manicurista', label_es: 'Manicurista', label_en: 'Nail technician' },
  { slug: 'auxiliar', label_es: 'Auxiliar de uñas', label_en: 'Nail assistant' },
  { slug: 'recepcion', label_es: 'Recepción y agenda', label_en: 'Front desk & scheduling' },
  { slug: 'practicante', label_es: 'Practicante o aprendiz', label_en: 'Intern or apprentice' },
  { slug: 'otro', label_es: 'Otro', label_en: 'Other' },
];

export async function seedJobRoles(strapi: Core.Strapi): Promise<void> {
  try {
    // Only seed a virgin install. Checking "is the table empty?" rather than
    // "does this slug exist?" means a role the owner removed on purpose stays
    // removed instead of reappearing after every restart.
    const count = await strapi.db.query(JOB_ROLE_UID).count({});
    if (count > 0) return;

    for (let i = 0; i < DEFAULT_ROLES.length; i++) {
      await strapi.documents(JOB_ROLE_UID as any).create({
        data: { ...DEFAULT_ROLES[i], order: i, active: true } as any,
      });
    }
    strapi.log.info(`[careers] seeded ${DEFAULT_ROLES.length} cargos`);
  } catch (err: any) {
    strapi.log.warn(`[careers] could not seed cargos: ${err?.message}`);
  }
}

/**
 * Active cargos by slug, for validating a submission. Read fresh on every
 * submission (no cache): a role the owner just closed must stop accepting
 * applications immediately.
 */
export async function getActiveRoleBySlug(
  strapi: Core.Strapi,
  slug: string,
): Promise<{ id: number; slug: string; label_es: string } | null> {
  if (!slug) return null;
  const rows = await strapi.db
    .query(JOB_ROLE_UID)
    .findMany({ where: { slug, active: true }, limit: 1 });
  const role = rows?.[0];
  return role ? { id: role.id, slug: role.slug, label_es: role.label_es } : null;
}
