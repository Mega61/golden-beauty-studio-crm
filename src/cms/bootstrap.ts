/**
 * Idempotent bootstrap for the public-facing marketing CMS (lookbook, promos,
 * pricing, bio). Safe to run on every boot.
 *
 *  1. ensureLocales       — es (default) + en, so content can be localized.
 *  2. ensurePublicRead    — grant the Public role find/findOne on the content
 *                           types the landing fetches anonymously.
 */
import type { Core } from '@strapi/strapi';

// Content types the landing reads without auth. Extend per phase.
export const PUBLIC_READ_UIDS: string[] = [
  'api::lookbook-category.lookbook-category',
  'api::lookbook-item.lookbook-item',
  // Phase 2+: 'api::promo-scenario.promo-scenario',
  // Phase 3+: 'api::price-category.price-category',
  // Phase 4+: 'api::link-bio.link-bio',
];

async function ensureLocales(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('i18n').service('locales');
  const existing: Array<{ code: string }> = await service.find();
  const codes = new Set(existing.map((l) => l.code));

  if (!codes.has('es')) {
    await service.create({ code: 'es', name: 'Spanish (es)' });
    strapi.log.info('[cms] created locale es');
  }
  if (!codes.has('en')) {
    await service.create({ code: 'en', name: 'English (en)' });
    strapi.log.info('[cms] created locale en');
  }

  try {
    const current = await service.getDefaultLocale();
    if (current !== 'es') {
      await service.setDefaultLocale({ code: 'es' });
      strapi.log.info('[cms] default locale set to es');
    }
  } catch (err: any) {
    strapi.log.warn(`[cms] could not set default locale: ${err?.message}`);
  }
}

async function ensurePublicRead(strapi: Core.Strapi): Promise<void> {
  const role = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });
  if (!role) {
    strapi.log.warn('[cms] public role not found — skipping read grants');
    return;
  }

  for (const uid of PUBLIC_READ_UIDS) {
    for (const verb of ['find', 'findOne']) {
      const action = `${uid}.${verb}`;
      // The action only exists once the content type is registered; skip if not.
      const existing = await strapi.db
        .query('plugin::users-permissions.permission')
        .findOne({ where: { action, role: role.id } });
      if (!existing) {
        try {
          await strapi.db
            .query('plugin::users-permissions.permission')
            .create({ data: { action, role: role.id } });
          strapi.log.info(`[cms] granted Public ${action}`);
        } catch (err: any) {
          strapi.log.warn(`[cms] could not grant ${action}: ${err?.message}`);
        }
      }
    }
  }
}

export async function bootstrapCms(strapi: Core.Strapi): Promise<void> {
  await ensureLocales(strapi);
  await ensurePublicRead(strapi);
}
