/**
 * First-run seed for the lookbook taxonomy. Creates the six technique
 * categories (matching the landing's CATEGORY_LABELS / CATEGORY_ORDER) if they
 * don't exist yet, so the owner can start attaching photos immediately.
 *
 * Idempotent and keyed by slug: editing a label in the admin will NOT be
 * overwritten on the next boot. Photos (lookbook items) are added by the owner
 * via the admin, or in bulk via scripts/import-lookbook.mjs.
 */
import type { Core } from '@strapi/strapi';

const CATEGORY_UID = 'api::lookbook-category.lookbook-category';

const CATEGORIES: Array<{
  slug: string;
  label_es: string;
  label_en: string;
}> = [
  { slug: 'acrilico', label_es: 'Acrílico', label_en: 'Acrylic' },
  { slug: 'polygel', label_es: 'Polygel', label_en: 'Polygel' },
  { slug: 'builder-gel', label_es: 'Builder gel', label_en: 'Builder gel' },
  { slug: 'dipping', label_es: 'Dipping', label_en: 'Dipping' },
  { slug: 'semipermanente', label_es: 'Semi', label_en: 'Semi' },
  { slug: 'press-on', label_es: 'Press On', label_en: 'Press On' },
];

export async function seedLookbook(strapi: Core.Strapi): Promise<void> {
  let created = 0;
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    const existing = await strapi.documents(CATEGORY_UID).findMany({
      filters: { slug: cat.slug },
      limit: 1,
    });
    if (existing.length > 0) continue;
    await strapi.documents(CATEGORY_UID).create({
      data: { ...cat, order: i },
    });
    created++;
  }
  if (created > 0) {
    strapi.log.info(`[cms] seeded ${created} lookbook categor${created === 1 ? 'y' : 'ies'}`);
  }
}
