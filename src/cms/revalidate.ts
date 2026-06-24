/**
 * On-demand revalidation: when the owner saves marketing content, ping the
 * landing's /api/revalidate so the change shows on the live site in ~2s instead
 * of waiting out the page's 60s ISR window. This is what makes "save → look at
 * the website" feel instant for the owner (see the Preview button in
 * config/plugins.ts).
 *
 * Best-effort and debounced: a burst of writes (e.g. publishing several items)
 * collapses into one call, and any network failure is logged, never thrown — a
 * failed ping just means the site updates on its normal 60s cadence instead.
 *
 * Disabled (no-op) until REVALIDATE_URL + REVALIDATE_SECRET are set, so local
 * dev and the first boot don't emit errors.
 */
import type { Core } from '@strapi/strapi';

// The content types the landing renders. A write to any of them should refresh
// the live page.
const WATCHED_UIDS = [
  'api::lookbook-item.lookbook-item',
  'api::lookbook-category.lookbook-category',
  'api::hero.hero',
  'api::studio-photo.studio-photo',
  'api::price-category.price-category',
  'api::price-item.price-item',
];

export function registerRevalidation(strapi: Core.Strapi): void {
  const url = process.env.REVALIDATE_URL?.trim();
  const secret = process.env.REVALIDATE_SECRET?.trim();
  if (!url || !secret) {
    strapi.log.info(
      '[cms] revalidation disabled (set REVALIDATE_URL + REVALIDATE_SECRET to enable instant landing updates)',
    );
    return;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'x-revalidate-secret': secret },
        });
        strapi.log.info(`[cms] revalidate -> ${res.status}`);
      } catch (err: any) {
        strapi.log.warn(`[cms] revalidate failed: ${err?.message}`);
      }
    }, 1500);
  };

  strapi.db.lifecycles.subscribe({
    models: WATCHED_UIDS,
    afterCreate: trigger,
    afterUpdate: trigger,
    afterDelete: trigger,
    afterCreateMany: trigger,
    afterUpdateMany: trigger,
    afterDeleteMany: trigger,
  });

  strapi.log.info('[cms] revalidation active');
}
